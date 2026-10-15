"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/src/db";
import { evidenceDbMessage, previewResearchEvidence, saveResearchEvidence, setEvidenceArchived, type EvidencePreview } from "@/src/db/research-evidence";
import { readResearchEvidenceFile } from "@/src/lib/research-evidence-file";
import { ResearchEvidenceError } from "@/src/lib/research-evidence";
import type { ActionResult } from "./actions";

export type EvidenceActionResult = ActionResult & {preview?:EvidencePreview;batchId?:string;selectionKey?:string};

// Vercel Preview deployments use the same DATABASE_URL as Production, so evidence mutations
// are refused there on the server before any database access. Read-only previews still work.
function refuseInVercelPreview(){
  if(process.env.VERCEL_ENV==="preview")throw new ResearchEvidenceError("Preview deployments are read-only for research evidence. Save, archive and restore are available in production or a local disposable database.");
}

export async function researchEvidenceAction(_previous:EvidenceActionResult|null,form:FormData):Promise<EvidenceActionResult>{
  const selectionKey=String(form.get("selectionKey")??"").slice(0,30);
  try{
    const intent=String(form.get("intent")??"");
    if(intent!=="preview" && intent!=="save")throw new ResearchEvidenceError("Choose Preview before saving evidence.");
    if(intent==="save")refuseInVercelPreview();
    const file=form.get("file");
    if(!(file instanceof File))throw new ResearchEvidenceError("Choose a CSV or XLSX research file.");
    const unit=String(form.get("sellThroughUnit")??"");
    if(unit!=="fraction" && unit!=="percent")throw new ResearchEvidenceError("Choose how sell-through values are expressed.");
    const parsed=await readResearchEvidenceFile(file,{blankSoldIsSkip:form.get("blankSoldIsSkip")==="on",sellThroughUnit:unit});
    const db=await getDb();
    if(intent==="preview"){
      const preview=await previewResearchEvidence(db,parsed);
      return {ok:true,message:`Preview ready: ${preview.counts.total} MPNs. Nothing has been saved.`,preview,selectionKey};
    }
    const digest=String(form.get("previewDigest")??"");
    if(!/^[a-f0-9]{64}$/.test(digest))throw new ResearchEvidenceError("Preview this file before saving evidence.");
    const saved=await saveResearchEvidence(db,parsed,digest);
    revalidatePath("/mpns/research-evidence");
    return {ok:true,batchId:saved.id,message:saved.existing
      ? "This source file is already saved. Its evidence and archive state were left unchanged."
      : `Saved ${parsed.rows.length} research observations. Active market facts and planning are unchanged.`,selectionKey};
  }catch(error){return {ok:false,message:evidenceDbMessage(error),selectionKey};}
}

export async function archiveResearchEvidenceAction(_previous:ActionResult|null,form:FormData):Promise<ActionResult>{
  try{
    refuseInVercelPreview();
    const intent=String(form.get("intent")??"");
    if(intent!=="archive" && intent!=="restore")throw new ResearchEvidenceError("Choose Archive or Restore.");
    const id=String(form.get("batchId")??"");
    const rawRevision=String(form.get("revision")??"");
    if(!/^\d+$/.test(rawRevision))throw new ResearchEvidenceError("Reload the batch page before changing its archive state.");
    await setEvidenceArchived(await getDb(),id,Number(rawRevision),intent==="archive");
    revalidatePath("/mpns/research-evidence");
    revalidatePath(`/mpns/research-evidence/${id}`);
    return {ok:true,message:intent==="archive" ? "Batch archived. Its evidence and history are retained." : "Batch restored to the current evidence list."};
  }catch(error){return {ok:false,message:evidenceDbMessage(error)};}
}
