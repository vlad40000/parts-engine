"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/app/actions";
import { FLEET_LOCATION_OPTIONS, fleetLocationChoice, type FleetLocationChoice } from "@/src/lib/fleet-location-options";

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className="btn btn-primary text-xs" disabled={pending}>{pending ? "Saving…" : "Save"}</button>;
}

/** A machine's physical placement; edited here, on Fleet and on machine detail. */
export function LocationEditCell({ machineNo, location, action }: {
  machineNo: string; location: string | null;
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<FleetLocationChoice | "">(fleetLocationChoice(location));
  const [other, setOther] = useState(fleetLocationChoice(location) === "__other" ? location ?? "" : "");
  const [result, formAction] = useActionState(action, null);
  useEffect(() => { if (result?.ok) setEditing(false); }, [result]);

  const cancel = () => {
    setChoice(fleetLocationChoice(location));
    setOther(fleetLocationChoice(location) === "__other" ? location ?? "" : "");
    setEditing(false);
  };

  return <div className="min-w-40">
    {editing ? <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="machineNo" value={machineNo} />
      <input type="hidden" name="expectedLocation" value={location ?? ""} />
      <select name="locationChoice" aria-label={`Physical location of machine ${machineNo}`}
        className="input w-44" required value={choice}
        onChange={(event) => setChoice(event.target.value as FleetLocationChoice | "")}>
        <option value="" disabled>Choose location…</option>
        {FLEET_LOCATION_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
        <option value="__other">Other</option>
        <option value="__clear">Clear location</option>
      </select>
      {choice === "__other" ? <input name="locationOther" aria-label={`Other location for machine ${machineNo}`}
        value={other} onChange={(event) => setOther(event.target.value)} required maxLength={120}
        placeholder="Specify location" className="input w-44" /> : null}
      <div className="flex flex-wrap gap-1"><SaveButton />
        <button type="button" className="btn text-xs" onClick={cancel}>Cancel</button></div>
      <p className="text-xs text-muted">Other allows an existing or custom location. Clear location is a separate action. Manual changes survive imports.</p>
    </form> : <div className="flex flex-wrap items-center gap-1">
      <span className="mono text-xs">{location || "—"}</span>
      <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => setEditing(true)}
        aria-label={`Edit location for machine ${machineNo}`}>Edit</button>
    </div>}
    {result ? <p role="status" className={`mt-1 text-xs ${result.ok ? "text-go" : "text-stop"}`}>{result.message}</p> : null}
  </div>;
}
