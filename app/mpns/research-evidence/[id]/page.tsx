import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, hasDatabase } from "@/src/db";
import { evidenceBatch, evidenceDbMessage } from "@/src/db/research-evidence";
import { NoDatabase, PageTitle } from "@/src/components/ui";
import { ButtonForm } from "@/src/components/forms";
import { EvidenceCountsView, EvidenceRowsView } from "@/src/components/research-evidence-view";
import { archiveResearchEvidenceAction } from "@/app/research-evidence-actions";

export const dynamic="force-dynamic";
export default async function ResearchEvidenceBatchPage({params}:{params:Promise<{id:string}>}){
  if(!hasDatabase())return <NoDatabase/>;
  const {id}=await params;
  let data;
  try{data=await evidenceBatch(await getDb(),id);}catch(e){return <><PageTitle title="Research evidence" sub="Batch history"/><p role="alert" className="card p-4 text-sm text-wait">{evidenceDbMessage(e)}</p></>;}
  if(!data)notFound();
  const {batch,rows}=data;
  return <>
    <PageTitle title={`Research batch ${batch.id.slice(0,8)}`} sub="Original observations, comparable subsets and Owner Skip decisions. This batch does not change active market facts or planning."/>
    <Link href="/mpns/research-evidence?archived=1" className="mb-3 inline-block underline">All evidence batches</Link>
    <section className="card mb-4 p-4">
      <p className="font-semibold">{batch.archived_at ? "Archived" : "Current evidence"}</p>
      <EvidenceCountsView counts={batch.counts}/>
      <p className="mb-3 text-xs text-muted">Imported {String(batch.created_at)}. Source observation dates are shown per row.</p>
      <ButtonForm action={archiveResearchEvidenceAction} label={batch.archived_at ? "Restore batch" : "Archive batch"}>
        <input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="revision" value={batch.revision}/>
        <input type="hidden" name="intent" value={batch.archived_at ? "restore" : "archive"}/>
      </ButtonForm>
      <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Provenance and archive history</summary>
        <p className="break-all">Source SHA-256: {batch.source_sha256}</p><p>Source: {batch.source} · reader version {batch.parser_version} · sheet {batch.metadata.sheet??"CSV"}</p>
        <ul>{batch.lifecycle_events.map((e,i)=><li key={i}>{e.action} · {e.at}</li>)}</ul>
      </details>
    </section>
    <EvidenceRowsView rows={rows}/>
  </>;
}
