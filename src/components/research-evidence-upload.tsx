"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { EvidenceActionResult } from "@/app/research-evidence-actions";
import { EvidenceCountsView, EvidenceRowsView } from "./research-evidence-view";

function EvidenceButtons({canSave}:{canSave:boolean}){
  const {pending}=useFormStatus();
  return <div className="mt-3 flex flex-wrap gap-2">
    <button name="intent" value="preview" disabled={pending} className="btn">{pending ? "Working…" : "Preview research evidence"}</button>
    <button name="intent" value="save" disabled={pending||!canSave} className="btn btn-primary">Save reviewed evidence</button>
  </div>;
}
export function ResearchEvidenceUpload({action}:{action:(previous:EvidenceActionResult|null,form:FormData)=>Promise<EvidenceActionResult>}){
  // Keep the original File in memory after React resets the form following preview.
  // Every save uploads and reparses those same bytes; client-supplied rows are never trusted.
  const file=useRef<File|null>(null);
  const [fileName,setFileName]=useState("");
  const [selection,setSelection]=useState(0);
  const [skip,setSkip]=useState(true);
  const [unit,setUnit]=useState("fraction");
  const [state,formAction]=useActionState(async(previous:EvidenceActionResult|null,form:FormData)=>{
    if(file.current)form.set("file",file.current);
    form.set("blankSoldIsSkip",skip ? "on" : "");
    form.set("sellThroughUnit",unit);
    return action(previous,form);
  },null);
  const current=state?.selectionKey===String(selection);
  const preview=current ? state?.preview : undefined;
  return <form action={formAction} onReset={(event)=>event.preventDefault()}>
    <label className="block text-sm">Research file (CSV or XLSX, up to 2 MiB)
      <input type="file" accept=".csv,.xlsx" className="input mt-1 block" onChange={(event)=>{
        file.current=event.target.files?.[0]??null;setFileName(file.current?.name??"");setSelection((n)=>n+1);
      }} />
    </label>
    {fileName ? <p className="mt-1 text-xs text-muted">Selected: {fileName}</p> : null}
    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" name="blankSoldIsSkip" checked={skip} onChange={(e)=>{setSkip(e.target.checked);setSelection((n)=>n+1);}} />Blank sold counts mean Owner Skip for this cycle</label>
      <label>Unmarked sell-through values: <select name="sellThroughUnit" value={unit} onChange={(e)=>{setUnit(e.target.value);setSelection((n)=>n+1);}} className="input">
        <option value="fraction">0.45 means 45%</option><option value="percent">45 means 45%</option>
      </select></label>
    </div>
    <input type="hidden" name="selectionKey" value={selection} />
    <input type="hidden" name="previewDigest" value={preview?.digest??""} />
    <EvidenceButtons canSave={!!preview} />
    {current && state ? <div role="status" className={`my-3 rounded border p-3 text-sm ${state.ok ? "border-go/30 bg-green-50" : "border-stop/30 bg-red-50"}`}>
      <p>{state.message}</p>{state.batchId ? <Link className="font-medium underline" href={`/mpns/research-evidence/${state.batchId}`}>Open saved batch</Link> : null}
    </div> : null}
    {preview ? <>
      <EvidenceCountsView counts={preview.counts} />
      <p className="mb-2 text-xs text-muted">{preview.counts.unresolved} identities need review · {preview.counts.conflicts} rows differ from active facts · {preview.counts.unknownDates} unknown original dates</p>
      <ul className="mb-3 list-disc pl-5 text-xs text-muted">{preview.file.warnings.map((warning)=><li key={warning}>{warning}</li>)}</ul>
      <EvidenceRowsView rows={preview.rows} />
    </> : null}
  </form>;
}
