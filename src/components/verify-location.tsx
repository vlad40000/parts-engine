"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/app/actions";
import type { LocationCheckRow } from "@/src/db/tech-notes";

function Save() {
  const { pending } = useFormStatus();
  return <button className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : "I checked: it is here"}</button>;
}

/**
 * VERIFY LOCATION: a recorded location conflicts with the record. Both stay in the history;
 * only someone who has physically checked clears it, by saying where the machine is.
 */
export function VerifyLocation({ machineNo, current, checks, action }: {
  machineNo: string; current: string | null; checks: LocationCheckRow[];
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [result, formAction] = useActionState(action, null);
  const places = [...new Set([current, ...checks.flatMap((c) => [c.recorded_location, c.previous_location])].filter((x): x is string => Boolean(x && x.trim())))];
  const [choice, setChoice] = useState(places[0] ?? "__other");
  if (result?.ok) return <div role="status" className="card mb-5 border-go p-3 text-sm text-go">{result.message}</div>;
  return (
    <section className="card mb-5 border-stop p-3 text-sm" aria-labelledby="verify-location">
      <h2 id="verify-location" className="font-semibold"><span className="pill pill-stop">VERIFY LOCATION</span> Where is #{machineNo}?</h2>
      <ul className="mt-2 list-disc pl-5 text-xs">
        {checks.map((c) => (
          <li key={c.id}>
            On record: {c.previous_location || "—"}; {c.tech_note_id ? <Link className="text-accent underline" href={`/notes/${c.tech_note_id}`}>tech note</Link> : "a note"} written {c.observed} says {c.recorded_location}.
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted">Shown now: {current || "—"}. This stays until someone looks at the machine and records where it is.</p>
      <form action={formAction} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="machineNo" value={machineNo} />
        {places.map((p) => (
          <label key={p} className="flex items-center gap-1"><input type="radio" name="location" value={p} checked={choice === p} onChange={() => setChoice(p)} />{p}</label>
        ))}
        <label className="flex items-center gap-1"><input type="radio" name="location" value="__other" checked={choice === "__other"} onChange={() => setChoice("__other")} />Somewhere else:</label>
        <input name="other" className="input w-44" maxLength={120} placeholder="where it is" aria-label="Where the machine is" onFocus={() => setChoice("__other")} />
        <Save />
      </form>
      {result && !result.ok ? <p role="alert" className="mt-1 text-xs text-stop">{result.message}</p> : null}
    </section>
  );
}
