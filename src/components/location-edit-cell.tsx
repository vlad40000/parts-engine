"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/app/actions";

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className="btn btn-primary text-xs" disabled={pending}>{pending ? "Saving…" : "Save"}</button>;
}

/** Physical location belongs to one donor machine, not a shared model or MPN. */
export function LocationEditCell({ machineNo, location, action }: {
  machineNo: string; location: string | null;
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [result, formAction] = useActionState(action, null);
  useEffect(() => { if (result?.ok) setEditing(false); }, [result]);
  return <div className="min-w-40">
    {editing ? <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="machineNo" value={machineNo} />
      <input type="hidden" name="expectedLocation" value={location ?? ""} />
      <input name="location" aria-label={`Physical location of machine ${machineNo}`}
        defaultValue={location ?? ""} maxLength={120} placeholder="YARD-A3 / RACK-B2" className="input w-44" />
      <div className="flex flex-wrap gap-1"><SaveButton />
        <button type="button" className="btn text-xs" onClick={() => setEditing(false)}>Cancel</button></div>
      <p className="text-xs text-muted">Blank clears the location. A manual location survives future imports.</p>
    </form> : <div className="flex flex-wrap items-center gap-1">
      <span className="mono text-xs">{location || "—"}</span>
      <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => setEditing(true)}
        aria-label={`Edit location for machine ${machineNo}`}>Edit</button>
    </div>}
    {result ? <p role="status" className={`mt-1 text-xs ${result.ok ? "text-go" : "text-stop"}`}>{result.message}</p> : null}
  </div>;
}
