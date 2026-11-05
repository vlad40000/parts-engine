"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/app/actions";

function Save() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="btn btn-primary text-xs">{pending ? "Saving…" : "Save"}</button>;
}

/** An LG variant is a nameplate fact, never inferred from a related model or serial. */
export function LgVariationEditCell({ machineNo, brand, model, serial, variation, productCode, action }: {
  machineNo: string; brand: string; model: string; serial: string;
  variation: string | null; productCode: string | null;
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [result, formAction] = useActionState(action, null);
  useEffect(() => { if (result?.ok) setEditing(false); }, [result]);
  if (brand.trim().toUpperCase() !== "LG") return <span className="text-muted">—</span>;
  return <div className="min-w-36">
    {editing ? <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="machineNo" value={machineNo} />
      <input type="hidden" name="expectedModel" value={model} />
      <input type="hidden" name="expectedBrand" value={brand} />
      <input type="hidden" name="expectedSerial" value={serial} />
      <input type="hidden" name="expectedVariation" value={variation ?? ""} />
      <input type="hidden" name="expectedProductCode" value={productCode ?? ""} />
      <label className="text-xs">Variation
        <input name="variation" defaultValue={variation ?? ""} required maxLength={12} placeholder="ABWEVUS" className="input mono w-36" />
      </label>
      <label className="text-xs">Product code (optional)
        <input name="productCode" defaultValue={productCode ?? ""} maxLength={120} placeholder="T1780WFFV.ABWEVUS" className="input mono w-52" />
      </label>
      <div className="flex gap-1"><Save /><button type="button" className="btn text-xs" onClick={() => setEditing(false)}>Cancel</button></div>
      <p className="text-xs text-muted">Read from this machine's nameplate. Other variations cannot be assumed compatible.</p>
    </form> : <div className="flex flex-wrap gap-2 items-center">
      <span className="mono">{variation ?? "VERIFY VARIATION"}</span>
      <button type="button" onClick={() => setEditing(true)} className="btn text-xs px-2 py-0.5" aria-label={`Edit LG variation for machine ${machineNo}`}>Edit</button>
      {productCode ? <span className="text-muted text-xs">{productCode}</span> : null}
    </div>}
    {result ? <p role="status" className={`mt-1 text-xs ${result.ok ? "text-go" : "text-stop"}`}>{result.message}</p> : null}
  </div>;
}
