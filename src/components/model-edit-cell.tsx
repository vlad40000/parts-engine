"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/app/actions";

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className="btn btn-primary text-xs" disabled={pending}>{pending ? "Saving…" : "Save"}</button>;
}

/** Inline editor keyed to one machine number, never to a shared model BOM. */
export function ModelEditCell({ machineNo, model, brand, serial, identityStatus, action }: {
  machineNo: string; model: string; brand: string; serial: string; identityStatus: string;
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [result, formAction] = useActionState(action, null);
  useEffect(() => { if (result?.ok) setEditing(false); }, [result]);
  return <div className="min-w-44">
    {editing ? <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="machineNo" value={machineNo} />
      <input type="hidden" name="expectedModel" value={model} />
      <input type="hidden" name="expectedBrand" value={brand} />
      <input type="hidden" name="expectedSerial" value={serial} />
      <input name="model" aria-label={`New model number for machine ${machineNo}`} defaultValue={model} required maxLength={120} className="input mono w-48" />
      <div className="flex flex-wrap gap-1"><SaveButton /><button type="button" className="btn text-xs" onClick={() => setEditing(false)}>Cancel</button></div>
      <p className="text-xs text-muted">Only machine #${machineNo} changes. Shared parts lists are not rewritten.</p>
    </form> : <div className="flex flex-wrap items-center gap-2">
      <span className="mono">{model || "—"}</span>
      {identityStatus !== "ok" ? <span className="pill pill-wait">nameplate</span> : null}
      <button type="button" onClick={() => setEditing(true)} className="btn px-2 py-0.5 text-xs" aria-label={`Edit model for machine ${machineNo}`}>Edit</button>
    </div>}
    {result ? <p role="status" className={`mt-1 text-xs ${result.ok ? "text-go" : "text-stop"}`}>{result.message}</p> : null}
  </div>;
}
