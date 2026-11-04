"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/app/actions";
import { FLEET_STATUS_OPTIONS } from "@/src/lib/fleet-status";
import { FLEET_LOCATION_OPTIONS, type FleetLocationChoice } from "@/src/lib/fleet-location-options";

function ConfirmButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Saving verification…" : "Confirm return and save"}</button>;
}

/** One physical check, one atomic status+location update. Photo notes are retained. */
export function VerifyReturn({ machineNo, status, location, action }: {
  machineNo: string; status: string; location: string | null;
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [selectedStatus, setSelectedStatus] = useState("");
  const [choice, setChoice] = useState<FleetLocationChoice | "">("");
  const [other, setOther] = useState("");
  const [result, formAction] = useActionState(action, null);
  const active = FLEET_STATUS_OPTIONS.filter((s) => s !== "SOLD" && s !== "SCRAPPED");

  return <section role="alert" className="card mb-4 border border-stop/40 bg-amber-50 p-3 text-sm">
    <div className="font-semibold"><span className="pill pill-stop">VERIFY RETURN</span> Possible re-entry after SOLD</div>
    <p className="mt-2">
      A handwritten observation puts this machine on the lot despite a SOLD status or location marker.
      If it actually returned, inspect its machine ID and current physical location, then save both values below.
      The old note and sale history are preserved automatically; no need to reopen the note to clear this alert.
      If the photograph predates the sale or you cannot confirm a return, do not change Fleet.
    </p>
    <p className="mt-2 text-xs text-muted">Currently: {status} · {location || "Location unknown"}</p>
    <form action={formAction} className="mt-3 flex flex-wrap items-end gap-3">
      <input type="hidden" name="machineNo" value={machineNo} />
      <input type="hidden" name="expectedStatus" value={status} />
      <input type="hidden" name="expectedLocation" value={location ?? ""} />
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold">Current status</span>
        <select name="status" required className="input min-w-40" value={selectedStatus}
          onChange={(e) => setSelectedStatus(e.target.value)}>
          <option value="" disabled>Choose status…</option>
          {active.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold">Physical location</span>
        <select name="locationChoice" required className="input min-w-40" value={choice}
          onChange={(e) => setChoice(e.target.value as FleetLocationChoice | "")}>
          <option value="" disabled>Choose location…</option>
          {FLEET_LOCATION_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          <option value="__other">Other…</option>
        </select>
      </label>
      {choice === "__other" ? <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold">Other location</span>
        <input name="locationOther" className="input" value={other} onChange={(e) => setOther(e.target.value)}
          maxLength={120} required placeholder="Where is it now?" />
      </label> : null}
      <label className="flex items-center gap-2 text-xs">
        <input name="physicallyVerified" value="yes" type="checkbox" required />
        I checked this machine in person
      </label>
      <ConfirmButton />
    </form>
    {result ? <p role="status" className={`mt-3 text-sm ${result.ok ? "text-go" : "text-stop"}`}>{result.message}</p> : null}
  </section>;
}
