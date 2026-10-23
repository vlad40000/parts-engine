"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/app/actions";
import { FLEET_STATUS_OPTIONS, isEditableFleetStatus } from "@/src/lib/fleet-status";

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className="btn btn-primary text-xs" disabled={pending}>{pending ? "Saving…" : "Save"}</button>;
}

/** Edit the operational status of one machine, preserving all shared model BOMs. */
export function StatusEditCell({ machineNo, status, action }: {
  machineNo: string;
  status: string;
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [result, formAction] = useActionState(action, null);
  useEffect(() => { if (result?.ok) setEditing(false); }, [result]);
  return <div className="min-w-40">
    {editing ? <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="machineNo" value={machineNo} />
      <input type="hidden" name="expectedStatus" value={status} />
      <select name="status" aria-label={`New status for machine ${machineNo}`} defaultValue={isEditableFleetStatus(status) ? status : ""} required className="input w-44">
        {!isEditableFleetStatus(status) ? <option value="" disabled>Replace legacy: {status}</option> : null}
        {FLEET_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <div className="flex flex-wrap gap-1"><SaveButton /><button type="button" className="btn text-xs" onClick={() => setEditing(false)}>Cancel</button></div>
      <p className="text-xs text-muted">SOLD and SCRAPPED are excluded from donor searches.</p>
    </form> : <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs">{status}</span>
      <button type="button" onClick={() => setEditing(true)} className="btn px-2 py-0.5 text-xs" aria-label={`Edit status for machine ${machineNo}`}>Edit</button>
    </div>}
    {result ? <p role="status" className={`mt-1 text-xs ${result.ok ? "text-go" : "text-stop"}`}>{result.message}</p> : null}
  </div>;
}
