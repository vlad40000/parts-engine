import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import path from "node:path";
import fs from "node:fs";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { evidenceHash, parseEvidenceTable, type EvidenceFile } from "@/src/lib/research-evidence";
import { evidenceBatch, evidenceBatches, previewResearchEvidence, saveResearchEvidence, setEvidenceArchived, evidenceDbMessage } from "@/src/db/research-evidence";
import { getSettings, getBaselines, mpnIndex, mpnDetail, teardownQueue, physicalReviewQueue, researchQueueCsvRows, saveSettings } from "@/src/db/queries";
import { researchEvidenceAction, archiveResearchEvidenceAction } from "@/app/research-evidence-actions";

const holder=vi.hoisted(()=>({db:null as unknown}));
vi.mock("@/src/db",()=>({getDb:async()=>holder.db,hasDatabase:()=>true}));
vi.mock("next/cache",()=>({revalidatePath:()=>undefined}));
let client:PGlite,db:Db;
const parse=(rows:Record<string,unknown>[],suffix=""):EvidenceFile=>parseEvidenceTable(rows,{
  sourceSha256:evidenceHash(JSON.stringify(rows)+suffix),format:"evidence_table",sheet:null,
  options:{blankSoldIsSkip:true,sellThroughUnit:"fraction"}
});
const source=(suffix="")=>parse([
  {mpn:"WPW10006355",sold90:"9",avgItem:"20.00000000000000001",avgBuyerShipping:"0",sellThrough:"0.08022",salesComparability:"PARTIAL EXACT-COMPARABLE",auditedSold90:"2",auditedAvgItem:"8.123456",auditedAvgBuyerShipping:"1.4133333333333333"},
  {mpn:"SKIP100",sold90:"",avgItem:"",avgBuyerShipping:"",sellThrough:"",ownerDecision:"OWNER SKIP"}
],suffix);
const count=async(table:string)=>(await db.execute(sql`select count(*)::int n from ${sql.identifier(table)}`)).rows[0].n;

beforeAll(async()=>{
  client=new PGlite();db=drizzle(client,{schema}) as unknown as Db;holder.db=db;
  await migrate(drizzle(client),{migrationsFolder:path.join(__dirname,"..","drizzle")});
  await db.execute(sql`insert into mpn_master(mpn_canonical,mpn_display,description,part_family) values
    ('W10006355','WPW10006355','Synthetic washer drain pump','pump'),('W10721967','W10721967','Synthetic washer pulley','drive')`);
  await db.execute(sql`insert into mpn_alias(alias_canonical,mpn_canonical,kind) values
    ('WPW10006355','W10006355','wp_prefix'),('WPW10721967','W10006355','wp_prefix'),
    ('OLD100','W10006355','supersedes'),('VAR100','W10006355','variant')`);
  await db.execute(sql`insert into market_facts(mpn_canonical,sold_90,avg_price,avg_ship,sell_through_pct,sell_through_source,researched_at,source)
    values('W10006355',3,20,9,50,'manual','2026-10-15','manual')`);
  await db.execute(sql`update mpn_master set appliance_hint='Washer' where mpn_canonical='W10006355'`);
  await db.execute(sql`insert into fleet_machines(machine_no,brand,brand_key,model_raw,model_key,identity_status,availability,appliance_type)
    values('SYNTH1','Whirlpool','WHIRLPOOL','SYNTHMODEL','SYNTHMODEL','ok','PARTS ONLY','Washer - Top Load')`);
  await db.execute(sql`insert into model_bom_cache(brand_key,model_key,brand_display,model_display,status)
    values('WHIRLPOOL','SYNTHMODEL','Whirlpool','SYNTHMODEL','found')`);
  await db.execute(sql`insert into model_part_edges(brand_key,model_key,mpn_canonical,mpn_display,description,source)
    values('WHIRLPOOL','SYNTHMODEL','W10006355','WPW10006355','Synthetic washer drain pump','test')`);
  await saveSettings(db,{...(await getSettings(db)),minimumSellThroughPct:20,minimumProfitMarginPct:5});
});
afterAll(async()=>{await client.close();});

describe("research evidence storage",()=>{
  it("preview is zero-write and exposes exact WP identity and active conflicts",async()=>{
    const before=await count("research_evidence_batches");
    const preview=await previewResearchEvidence(db,source());
    expect(preview.counts).toMatchObject({total:2,researched:1,ownerSkip:1,conflicts:1,unresolved:1,unknownDates:2});
    expect(preview.rows[0]).toMatchObject({resolvedMpnKey:"W10006355",resolution:"wp_alias",conflicts:["sold quantity","item price","buyer shipping","sell-through"]});
    expect(await count("research_evidence_batches")).toBe(before);
    expect(await count("research_evidence_rows")).toBe(0);
  });
  it("does not merge supersessions, variants, wrong WP targets or unpersisted aliases",async()=>{
    const file=parse(["OLD100","VAR100","WPW10721967","WPUNKNOWN100"].map(mpn=>({mpn,sold90:3})));
    const p=await previewResearchEvidence(db,file);
    expect(p.rows.map(r=>r.resolvedMpnKey)).toEqual([null,null,null,null]);
    expect(p.rows[0].resolution).toBe("relationship_only");
    await expect(previewResearchEvidence(db,parse([{mpn:"W10006355",sold90:3},{mpn:"WPW10006355",sold90:4}]))).rejects.toThrow("same exact MPN");
  });
  it("saves original raw evidence and audited subsets without touching any planning outputs",async()=>{
    const snapshot=async()=>({
      settings:await getSettings(db),baselines:await getBaselines(db),index:await mpnIndex(db,{view:"all"}),
      detail:await mpnDetail(db,"W10006355"),queue:await teardownQueue(db),physical:await physicalReviewQueue(db),csv:await researchQueueCsvRows(db),
      facts:(await db.select().from(schema.marketFacts)),master:(await db.select().from(schema.mpnMaster)),stock:(await db.select().from(schema.machinePartState))
    });
    const before=await snapshot(),file=source(),preview=await previewResearchEvidence(db,file);
    expect(before.detail?.mpn.qualification?.result).toBe("QUALIFIED");
    expect(before.queue.rows).toHaveLength(1);
    const saved=await saveResearchEvidence(db,file,preview.digest);
    expect(saved.existing).toBe(false);
    const stored=await evidenceBatch(db,saved.id);
    expect(stored?.rows[0]).toMatchObject({mpnDisplay:"WPW10006355",inputMpnKey:"WPW10006355",resolvedMpnKey:"W10006355",raw:{price:"20.00000000000000001"},audited:{avgItem:"8.123456",avgBuyerShipping:"1.4133333333333333"},observedOn:null});
    expect(stored?.rows[1]).toMatchObject({decision:"owner_skip",metrics:{sold90:null},raw:{sold:""}});
    expect(await snapshot()).toEqual(before);
  });
  it("same file and concurrent retries are idempotent and leave archived evidence unchanged",async()=>{
    const file=source(),preview=await previewResearchEvidence(db,file);
    const one=await saveResearchEvidence(db,file,preview.digest);
    const before=await evidenceBatch(db,one.id);
    const repeats=await Promise.all([saveResearchEvidence(db,file,preview.digest),saveResearchEvidence(db,file,preview.digest)]);
    expect(repeats).toEqual([{id:one.id,existing:true},{id:one.id,existing:true}]);
    expect(await evidenceBatch(db,one.id)).toEqual(before);
    await setEvidenceArchived(db,one.id,0,true);
    expect((await saveResearchEvidence(db,file,preview.digest)).existing).toBe(true);
    expect((await evidenceBatch(db,one.id))?.batch.archived_at).not.toBeNull();
  });
  it("archive and restore retain records and lifecycle history; stale revisions cannot overwrite changes",async()=>{
    const batch=(await evidenceBatches(db,true))[0];
    expect(await evidenceBatches(db)).toHaveLength(0);
    expect(await evidenceBatches(db,true,"WPW10006355")).toHaveLength(1);
    expect(await evidenceBatches(db,true,"OLD100")).toHaveLength(0);
    await expect(setEvidenceArchived(db,batch.id,0,false)).rejects.toThrow("changed");
    await setEvidenceArchived(db,batch.id,1,false);
    const restored=await evidenceBatch(db,batch.id);
    expect(restored?.batch).toMatchObject({archived_at:null,revision:2});
    expect(restored?.batch.lifecycle_events.map(e=>e.action)).toEqual(["archived","restored"]);
    expect(restored?.rows).toHaveLength(2);
    expect(await evidenceBatches(db)).toHaveLength(1);
  });
  it("stale previews and a failed component insert leave no partial batch",async()=>{
    const file=source("stale"),preview=await previewResearchEvidence(db,file);
    await db.execute(sql`update market_facts set sold_90=4 where mpn_canonical='W10006355'`);
    const before=await count("research_evidence_batches");
    await expect(saveResearchEvidence(db,file,preview.digest)).rejects.toThrow("changed after preview");
    expect(await count("research_evidence_batches")).toBe(before);
    const bad=source("constraint");bad.rows[0].sourceRow=-1;
    const p=await previewResearchEvidence(db,bad);
    await expect(saveResearchEvidence(db,bad,p.digest)).rejects.toThrow();
    expect(await count("research_evidence_batches")).toBe(before);
    expect(await count("research_evidence_rows")).toBe(2);
  });
  it("concurrent first saves create one batch and one complete row set",async()=>{
    const file=source("new-concurrent"),p=await previewResearchEvidence(db,file);
    const results=await Promise.all([saveResearchEvidence(db,file,p.digest),saveResearchEvidence(db,file,p.digest)]);
    expect(results[0].id).toBe(results[1].id);
    expect((await evidenceBatch(db,results[0].id))?.rows).toHaveLength(2);
  });
  it("generated migration constraint names match the current snapshot",async()=>{
    const s=JSON.parse(fs.readFileSync(path.join(__dirname,"../drizzle/meta/0004_snapshot.json"),"utf8"));
    for(const table of ["research_evidence_batches","research_evidence_rows"]){
      const t=s.tables[`public.${table}`];
      const expected=[...Object.keys(t.foreignKeys),...Object.keys(t.uniqueConstraints),...Object.keys(t.checkConstraints),
        ...(table==="research_evidence_batches" ? ["research_evidence_batches_pkey"] : Object.keys(t.compositePrimaryKeys))].sort();
      const actual=(await db.execute(sql`select conname from pg_constraint where conrelid=${table}::regclass and contype in ('f','p','c','u') order by conname`)).rows as {conname:string}[];
      expect(actual.map(r=>r.conname)).toEqual(expected);
    }
  });
});

describe("deliberate import actions",()=>{
  const form=(intent:string)=>{
    const f=new FormData();f.set("file",new File(["mpn,sold90,avgItem\nSYNTH999,0,10.123456789\n"],"person@example.invalid.csv"));
    f.set("intent",intent);f.set("blankSoldIsSkip","on");f.set("sellThroughUnit","fraction");f.set("selectionKey","1");return f;
  };
  it("previews without writing, requires its digest, reparses the file, then saves",async()=>{
    const before=await count("research_evidence_batches");
    const preview=await researchEvidenceAction(null,form("preview"));
    expect(preview).toMatchObject({ok:true,selectionKey:"1",preview:{counts:{total:1,researched:1,ownerSkip:0}}});
    expect(await count("research_evidence_batches")).toBe(before);
    expect(await researchEvidenceAction(null,form("save"))).toMatchObject({ok:false});
    const f=form("save");f.set("previewDigest",preview.preview!.digest);
    const saved=await researchEvidenceAction(null,f);expect(saved.ok).toBe(true);
    expect(JSON.stringify(await evidenceBatch(db,saved.batchId!))).not.toContain("person@example");
    const a=new FormData();a.set("batchId",saved.batchId!);a.set("revision","0");a.set("intent","archive");
    expect(await archiveResearchEvidenceAction(null,a)).toMatchObject({ok:true});
  });
  it("uses a fixed message for unknown database failures",async()=>{
    const original=holder.db;holder.db={execute:async()=>{throw new Error("secret connection query");}};
    const result=await researchEvidenceAction(null,form("preview"));holder.db=original;
    expect(result).toMatchObject({ok:false});expect(result.message).not.toContain("secret");
    expect(evidenceDbMessage({cause:{code:"42P01",message:'relation "research_evidence_rows" does not exist'}})).toContain("pending database update");
  });
});
