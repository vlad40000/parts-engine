"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import type { ActionResult } from "@/app/actions";
import { DISPOSITION_LABEL, nextSteps, type Disposition, type DispositionStep } from "@/src/lib/part-disposition";

const STEP_LABEL: Record<Exclude<DispositionStep, "back">, string> = {
  ebay: "eBay", repair: "Repair", listed: "Listed", sold: "Sold", unlisted: "Unlisted"
};

/** State cell for a pulled part: eBay or Repair, then Listed / Sold / Unlisted. Undo steps back one level. */
export function PartDispositionControl({ machineNo, mpn, disposition, soldPrice, repairMachineNo, action }: {
  machineNo: string; mpn: string; disposition: Disposition | null; soldPrice: string | null; repairMachineNo: string | null;
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [mode, setMode] = useState<"repair" | "sold" | null>(null);
  const [result, formAction, pending] = useActionState(action, null);
  useEffect(() => { if (result?.ok) setMode(null); }, [result]);
  useEffect(() => { setMode(null); }, [disposition]);

  const btn = "btn px-2 py-0.5 text-xs";
  const detail = disposition === "sold" && soldPrice !== null ? ` $${Number(soldPrice).toFixed(2)}` : "";

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-1">
      <input type="hidden" name="machineNo" value={machineNo} />
      <input type="hidden" name="mpn" value={mpn} />
      <input type="hidden" name="from" value={disposition ?? ""} />
      <span className="pill pill-mute mr-1">
        pulled{disposition ? ` · ${DISPOSITION_LABEL[disposition]}${detail}` : ""}
        {disposition === "repair" && repairMachineNo ? (
          <> → <Link className="text-accent underline" href={`/machines/${encodeURIComponent(repairMachineNo)}`}>#{repairMachineNo}</Link></>
        ) : null}
      </span>
      {mode === "repair" ? (
        <>
          <input name="repairMachineNo" className="input w-24 px-1 py-0.5 text-xs" placeholder="Machine ID" aria-label="Machine ID the part went into" required autoFocus />
          <button name="step" value="repair" className={`${btn} btn-primary`} disabled={pending}>Save</button>
          <button type="button" className={btn} onClick={() => setMode(null)}>Cancel</button>
        </>
      ) : mode === "sold" ? (
        <>
          <input name="soldPrice" inputMode="decimal" className="input w-20 px-1 py-0.5 text-xs" placeholder="Sold $" aria-label="Sold price" required autoFocus />
          <button name="step" value="sold" className={`${btn} btn-primary`} disabled={pending}>Save</button>
          <button type="button" className={btn} onClick={() => setMode(null)}>Cancel</button>
        </>
      ) : (
        <>
          {nextSteps(disposition).map((s) => s === "repair" || s === "sold"
            ? <button key={s} type="button" className={btn} disabled={pending} onClick={() => setMode(s)}>{STEP_LABEL[s]}</button>
            : <button key={s} name="step" value={s} className={btn} disabled={pending}>{STEP_LABEL[s as Exclude<DispositionStep, "back">]}</button>)}
          <button name="step" value="back" className={btn} disabled={pending} title="Step back one level">undo</button>
        </>
      )}
      {result && !result.ok ? <span className="w-full text-xs text-stop">{result.message}</span> : null}
    </form>
  );
}
