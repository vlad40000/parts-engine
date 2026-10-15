import Link from "next/link";
import { getDb, hasDatabase } from "@/src/db";
import { evidenceBatches, evidenceDbMessage, type EvidenceBatch } from "@/src/db/research-evidence";
import { NoDatabase, PageTitle } from "@/src/components/ui";
import { EvidenceCountsView } from "@/src/components/research-evidence-view";

export const dynamic="force-dynamic";
export default async function ResearchEvidencePage({searchParams}:{searchParams:Promise<{archived?:string;mpn?:string}>}){
  if(!hasDatabase())return <NoDatabase/>;
  const sp=await searchParams;
  let batches:EvidenceBatch[]=[],error:string|null=null;
  try{batches=await evidenceBatches(await getDb(),sp.archived==="1",sp.mpn??"");}catch(e){error=evidenceDbMessage(e);}
  return <>
    <PageTitle title="Research evidence" sub="Imported observations and Owner Skip decisions. Active market facts and planning remain separate."/>
    <Link href="/mpns#research-evidence" className="btn mb-4">Preview another research file</Link>
    <form className="mb-4 flex flex-wrap items-center gap-3 text-sm">
      <label>Exact MPN <input name="mpn" className="input mono" defaultValue={sp.mpn??""}/></label>
      <label className="flex items-center gap-2"><input type="checkbox" name="archived" value="1" defaultChecked={sp.archived==="1"}/>Include archived</label>
      <button className="btn">Filter batches</button>
    </form>
    {error ? <p role="alert" className="card p-4 text-sm text-wait">{error}</p> : null}
    {!error && !batches.length ? <p className="card p-4 text-sm text-muted">No matching evidence batches.</p> : null}
    {batches.map((batch)=><section key={batch.id} className="card mb-3 p-4">
      <Link className="font-medium text-accent underline" href={`/mpns/research-evidence/${batch.id}`}>Batch {batch.id.slice(0,8)} · {String(batch.created_at).slice(0,10)}</Link>
      <p className="text-xs text-muted">{batch.archived_at ? "Archived" : "Current evidence"} · {batch.metadata.format.replace(/_/g," ")}</p>
      <EvidenceCountsView counts={batch.counts}/>
    </section>)}
    <p className="mt-3 text-xs text-muted">Latest 100 matching batches. Filtering uses the original exact MPN or its recorded WP identity; replacement relationships are not merged.</p>
  </>;
}
