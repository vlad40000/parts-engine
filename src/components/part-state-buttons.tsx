"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/app/actions";

/** Initial Pulled/Failed/Missing decisions must match the row as rendered. */
export function PartStateButtons({ machineNo, mpn, state, token, action }: {
  machineNo: string; mpn: string; state: string | null; token: string | null;
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [result, formAction, pending] = useActionState(action, null);
  const options = state ? ["clear"] : ["pulled", "failed", "missing"];
  return <form action={formAction} className="flex flex-wrap gap-1">
    <input type="hidden" name="machineNo" value={machineNo} />
    <input type="hidden" name="mpn" value={mpn} />
    <input type="hidden" name="expectedState" value={state ?? ""} />
    <input type="hidden" name="token" value={token ?? ""} />
    {state ? <span className="pill pill-mute mr-1">{state}</span> : null}
    {options.map((option) => <button key={option} name="state" value={option}
      className="btn px-2 py-0.5 text-xs" disabled={pending}>{option === "clear" ? "undo" : option}</button>)}
    {result && !result.ok ? <span role="alert" className="w-full text-xs text-stop">{result.message}</span> : null}
  </form>;
}
