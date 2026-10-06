"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/app/actions";

function Submit({ label, pendingLabel = "Working…" }: { label: string; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return <button className="btn btn-primary" disabled={pending}>{pending ? pendingLabel : label}</button>;
}

function Result({ r }: { r: ActionResult | null }) {
  if (!r) return null;
  return (
    <div className={`mt-3 rounded border p-3 text-sm ${r.ok ? "border-go/30 bg-green-50" : "border-stop/30 bg-red-50"}`}>
      <div className="font-medium">{r.message}</div>
      {r.details?.length ? <ul className="mt-1 list-disc pl-5 text-xs text-muted">{r.details.map((d) => <li key={d}>{d}</li>)}</ul> : null}
    </div>
  );
}

export function UploadForm({ action, label, accept, children }: {
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  label: string;
  accept: string;
  children?: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction}>
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" name="file" accept={accept} className="input" required />
        <Submit label={label} />
      </div>
      <Result r={state} />
    </form>
  );
}

export function MachineForm({ action }: { action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult> }) {
  const [state, formAction] = useActionState(action, null);
  const field = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted">{label}</span>
      <input name={name} className="input" {...props} />
    </label>
  );
  return (
    <form action={formAction}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {field("machineNo", "Machine ID", { required: true })}
        {field("brand", "Brand", { required: true })}
        {field("model", "Model", { required: true, className: "input mono" })}
        {field("serial", "Serial", { className: "input mono" })}
        {field("applianceType", "Type", { placeholder: "Washer - Front Load" })}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted">Status</span>
          <select name="availability" className="input" defaultValue="UNCHECKED">
            {["UNCHECKED", "PARTS ONLY", "NEEDS PARTS", "BEING REPAIRED", "READY TO SALE"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        {field("condition", "Condition")}
        {field("diagnosis", "Why it was retired (failure symptom)", { placeholder: "won't drain, no power, …" })}
      </div>
      <div className="mt-3"><Submit label="Save machine" pendingLabel="Saving machine, reading parts list…" /></div>
      <Result r={state} />
    </form>
  );
}
