import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./types";
import { canonicalizeMpn, wpPrefixTarget } from "@/src/lib/mpn";
import { EVIDENCE_SOURCE, EVIDENCE_VERSION, evidenceHash, ResearchEvidenceError, type EvidenceFile, type EvidenceRow } from "@/src/lib/research-evidence";

export type EvidenceResolvedRow = EvidenceRow & {
  resolvedMpnKey: string | null; resolution: "exact" | "wp_alias" | "relationship_only" | "unresolved";
  activeFacts: {sold90:number|null;avgItem:string|null;avgBuyerShipping:string|null;sellThroughPercent:string|null;researchedOn:string|null} | null;
  conflicts: string[];
};
export type EvidenceCounts = {total:number;researched:number;ownerSkip:number;unreviewed:number;holds:number;unresolved:number;conflicts:number;unknownDates:number};
export type EvidencePreview = {file:EvidenceFile;rows:EvidenceResolvedRow[];counts:EvidenceCounts;digest:string};
export type EvidenceBatch = {
  id:string;source_sha256:string;source:string;parser_version:number;
  metadata:{format:EvidenceFile["format"];sheet:string|null;options:EvidenceFile["options"];warnings:string[]};
  counts:EvidenceCounts;created_at:string;archived_at:string|null;revision:number;
  lifecycle_events:{action:"archived"|"restored";at:string}[];
};
const decimalKey=(v:string|number):string=>{
  const [whole,fraction=""]=String(v).split(".");
  const w=whole.replace(/^0+(?=\d)/,"");
  const f=fraction.replace(/0+$/,"");
  return f ? `${w}.${f}` : w;
};
export const evidenceDbMessage = (error: unknown): string => {
  if(error instanceof ResearchEvidenceError)return error.message;
  const seen=new Set<unknown>();
  while(error && typeof error==="object" && !seen.has(error)){
    seen.add(error);
    const e=error as {code?:string;message?:string;cause?:unknown};
    if(e.code==="42P01" && /research_evidence_/.test(e.message??""))return "Research evidence is unavailable until the application administrator applies the pending database update.";
    error=e.cause;
  }
  return "Research evidence could not be loaded or saved. Try again; if it continues, contact the application administrator.";
};

/** Read-only preview, including identity collisions and conflicts with active facts. */
export async function previewResearchEvidence(db:Db,file:EvidenceFile):Promise<EvidencePreview>{
  const keys=file.rows.map((r)=>r.inputMpnKey);
  const result=await db.execute(sql`
    select m.mpn_canonical from mpn_master m
    where m.mpn_canonical in (select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))
       or m.mpn_canonical in (select a.mpn_canonical from mpn_alias a where a.alias_canonical in (select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)))
  `);
  const known=new Set((result.rows as {mpn_canonical:string}[]).map((r)=>r.mpn_canonical));
  const aliases=(await db.execute(sql`select alias_canonical,mpn_canonical,kind from mpn_alias
    where alias_canonical in (select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))`)).rows as {alias_canonical:string;mpn_canonical:string;kind:string}[];
  const aliasMap=new Map(aliases.map((r)=>[r.alias_canonical,r]));
  const resolved=file.rows.map((r)=>{
    const a=aliasMap.get(r.inputMpnKey);
    const direct=known.has(r.inputMpnKey);
    const wp=!direct && a?.kind==="wp_prefix" && wpPrefixTarget(r.inputMpnKey)===a.mpn_canonical && known.has(a.mpn_canonical);
    return {...r,resolvedMpnKey:direct ? r.inputMpnKey : wp ? a!.mpn_canonical : null,
      resolution:direct ? "exact" as const : wp ? "wp_alias" as const : a ? "relationship_only" as const : "unresolved" as const};
  });
  const identities=new Set<string>();
  for(const row of resolved){
    const identity=row.resolvedMpnKey??row.inputMpnKey;
    if(identities.has(identity))throw new ResearchEvidenceError("Two rows resolve to the same exact MPN through a persisted WP identity. Keep one; nothing was saved.");
    identities.add(identity);
  }
  const facts=(await db.execute(sql`select mpn_canonical,sold_90,avg_price,avg_ship,sell_through_pct,researched_at from market_facts
    where mpn_canonical in (select jsonb_array_elements_text(${JSON.stringify([...identities])}::jsonb))`)).rows as {
      mpn_canonical:string;sold_90:number|null;avg_price:string|null;avg_ship:string|null;sell_through_pct:string|null;researched_at:string|Date|null
    }[];
  const byMpn=new Map(facts.map((r)=>[r.mpn_canonical,r]));
  const rows:EvidenceResolvedRow[]=resolved.map((r)=>{
    const existing=byMpn.get(r.resolvedMpnKey??r.inputMpnKey);
    const activeFacts=existing ? {sold90:existing.sold_90,avgItem:existing.avg_price,avgBuyerShipping:existing.avg_ship,sellThroughPercent:existing.sell_through_pct,
      researchedOn:existing.researched_at instanceof Date ? existing.researched_at.toISOString().slice(0,10) : existing.researched_at} : null;
    const conflicts:string[]=[];
    if(activeFacts && r.decision!=="owner_skip"){
      for(const [label,a,b] of [
        ["sold quantity",r.metrics.sold90,activeFacts.sold90], ["item price",r.metrics.avgItem,activeFacts.avgItem],
        ["buyer shipping",r.metrics.avgBuyerShipping,activeFacts.avgBuyerShipping], ["sell-through",r.metrics.sellThrough?.percent,activeFacts.sellThroughPercent]
      ] as const){if(a!=null && b!=null && decimalKey(a)!==decimalKey(b))conflicts.push(label);}
    }
    return {...r,activeFacts,conflicts};
  });
  const counts:EvidenceCounts={total:rows.length,researched:0,ownerSkip:0,unreviewed:0,holds:0,unresolved:0,conflicts:0,unknownDates:0};
  for(const row of rows){
    if(row.decision==="researched")counts.researched++;
    else if(row.decision==="owner_skip")counts.ownerSkip++;else counts.unreviewed++;
    if(row.comparability==="noncomparable")counts.holds++;
    if(!row.resolvedMpnKey)counts.unresolved++;
    if(row.conflicts.length)counts.conflicts++;
    if(!row.observedOn)counts.unknownDates++;
  }
  return {file,rows,counts,digest:evidenceHash(JSON.stringify({file,rows,version:EVIDENCE_VERSION}))};
}

/** Atomically creates a batch and every observation. Repeated source hashes never
 * update original values, dates or archive state, including concurrent retries. */
export async function saveResearchEvidence(db:Db,file:EvidenceFile,expectedDigest:string):Promise<{id:string;existing:boolean}>{
  const preview=await previewResearchEvidence(db,file);
  if(preview.digest!==expectedDigest)throw new ResearchEvidenceError("The file, options or active facts changed after preview. Preview again before saving.");
  const prior=await db.execute(sql`select id from research_evidence_batches where source_sha256=${file.sourceSha256}`);
  if(prior.rows.length)return {id:(prior.rows[0] as {id:string}).id,existing:true};
  const id=randomUUID();
  const metadata=JSON.stringify({format:file.format,sheet:file.sheet,options:file.options,warnings:file.warnings});
  const records=JSON.stringify(preview.rows.map((r)=>({
    input_mpn_key:r.inputMpnKey,mpn_display:r.mpnDisplay,resolved_mpn_key:r.resolvedMpnKey,source_row:r.sourceRow,
    owner_decision:r.decision,comparability:r.comparability,observation:r
  })));
  const inserted=await db.execute(sql`
    with created as (
      insert into research_evidence_batches(id,source_sha256,source,parser_version,metadata,counts)
      values(${id}::uuid,${file.sourceSha256},${EVIDENCE_SOURCE},${EVIDENCE_VERSION},${metadata}::jsonb,${JSON.stringify(preview.counts)}::jsonb)
      on conflict(source_sha256) do nothing returning id
    ), observations as (
      insert into research_evidence_rows(batch_id,input_mpn_key,mpn_display,resolved_mpn_key,source_row,owner_decision,comparability,observation)
      select created.id,p.input_mpn_key,p.mpn_display,p.resolved_mpn_key,p.source_row,p.owner_decision,p.comparability,p.observation
      from created cross join jsonb_to_recordset(${records}::jsonb)
      as p(input_mpn_key text,mpn_display text,resolved_mpn_key text,source_row int,owner_decision text,comparability text,observation jsonb)
      returning batch_id
    ) select id,(select count(*)::int from observations) as row_count from created
  `);
  if(inserted.rows.length)return {id,existing:false};
  const existing=await db.execute(sql`select id from research_evidence_batches where source_sha256=${file.sourceSha256}`);
  if(!existing.rows.length)throw new ResearchEvidenceError("The batch could not be confirmed. Preview the same file again; duplicate imports are prevented.");
  return {id:(existing.rows[0] as {id:string}).id,existing:true};
}

export async function evidenceBatches(db:Db,includeArchived=false,mpn=""):Promise<EvidenceBatch[]>{
  const key=canonicalizeMpn(mpn);
  const result=await db.execute(sql`select b.* from research_evidence_batches b
    where (${includeArchived} or b.archived_at is null)
    ${key ? sql`and exists(select 1 from research_evidence_rows r where r.batch_id=b.id and (r.input_mpn_key=${key} or r.resolved_mpn_key=${key}))` : sql``}
    order by b.created_at desc,b.id desc limit 100`);
  return result.rows as EvidenceBatch[];
}
export async function evidenceBatch(db:Db,id:string):Promise<{batch:EvidenceBatch;rows:EvidenceResolvedRow[]}|null>{
  if(!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id))return null;
  const batch=(await db.execute(sql`select * from research_evidence_batches where id=${id}::uuid`)).rows[0] as EvidenceBatch|undefined;
  if(!batch)return null;
  const rows=(await db.execute(sql`select observation from research_evidence_rows where batch_id=${id}::uuid order by source_row,input_mpn_key`)).rows as {observation:EvidenceResolvedRow}[];
  return {batch,rows:rows.map((r)=>r.observation)};
}
export async function setEvidenceArchived(db:Db,id:string,revision:number,archived:boolean):Promise<void>{
  if(!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id) || !Number.isSafeInteger(revision) || revision<0)throw new ResearchEvidenceError("Invalid batch or revision. Reload the batch page.");
  const result=await db.execute(sql`update research_evidence_batches set
    archived_at=case when ${archived} then now() else null end,
    revision=revision+1,
    lifecycle_events=lifecycle_events || jsonb_build_array(jsonb_build_object('action',${archived ? "archived" : "restored"}::text,'at',now()))
    where id=${id}::uuid and revision=${revision}
      and ((${archived} and archived_at is null) or (not ${archived} and archived_at is not null))
    returning id`);
  if(!result.rows.length)throw new ResearchEvidenceError("This batch changed after you opened it. Reload the page before archiving or restoring.");
}
