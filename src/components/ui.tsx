import Link from "next/link";
import type { Qualification } from "@/src/lib/economics";
import type { RoadrunnerPerformance } from "@/src/db/queries";

export function PageTitle({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {sub ? <p className="mt-1 max-w-3xl text-sm text-muted">{sub}</p> : null}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

/** v7 qualification result. Never a settled verdict while the owner thresholds are unset. */
export function QualificationPill({ v, market }: { v: Qualification | null; market?: string }) {
  if (!v) return <span className="pill pill-mute">{market === "missing" ? "not researched" : "—"}</span>;
  if (v.result === "SET_RULE") return <span className="pill pill-mute" title="Set both qualification thresholds in Settings.">SET RULE</span>;
  if (v.result === "QUALIFIED") return <span className="pill pill-go" title={v.reasons.join(" ")}>QUALIFIED</span>;
  if (v.result === "NOT_QUALIFIED") return <span className="pill pill-stop" title={v.reasons.join(" ")}>NOT QUALIFIED · {v.failed.join(", ").replace(/_/g, " ")}</span>;
  return <span className="pill pill-wait" title={v.missing.join(", ")}>NEEDS DATA · {v.missing.join(", ").replace(/_/g, " ")}</span>;
}

export const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
export const pct = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(1)}%`);
/** Modeled value / slot-day: a ranking metric, not a probability. */
export const perSlotDay = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(3)}/day`);

/** "Oct 5", or "Oct 5, 2025" outside the current year. Dates are calendar dates (UTC). */
export function saleDay(isoDate: string, now = new Date()): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric", timeZone: "UTC" });
}

/** Compact Roadrunner sales history: "6 sold · avg $118 · last Oct 5" or "No recorded sales". */
export function RoadrunnerHistory({ p }: { p: RoadrunnerPerformance | null }) {
  if (!p) return <span className="text-xs text-muted">No recorded sales</span>;
  const parts = [`${p.unitsSold} sold`];
  if (p.avgItemPrice != null) parts.push(`avg $${Math.round(p.avgItemPrice)}`);
  parts.push(`last ${saleDay(p.lastSoldAt)}`);
  return <span className="whitespace-nowrap text-xs" title={`${p.saleEvents} sale events recorded by Roadrunner`}>{parts.join(" · ")}</span>;
}

export function Years({ years }: { years: number[] }) {
  if (!years?.length) return <span className="text-muted">—</span>;
  return <span className={years.length > 1 ? "text-wait" : ""} title={years.length > 1 ? "Serial allows several years" : "Single candidate year"}>{years.join(" / ")}</span>;
}

export function NoDatabase() {
  return (
    <div className="card max-w-2xl p-5 text-sm">
      <h2 className="mb-2 font-semibold">Database not connected</h2>
      <p className="text-muted">Set <code className="mono">DATABASE_URL</code> to a Neon connection string for this app&apos;s own database, then run <code className="mono">npm run db:migrate</code>.</p>
    </div>
  );
}

export function Pager({ total, limit, offset, href }: { total: number; limit: number; offset: number; href: (offset: number) => string }) {
  if (total <= limit) return null;
  return (
    <div className="mt-3 flex items-center gap-3 text-sm text-muted">
      {offset > 0 ? <Link className="btn" href={href(Math.max(0, offset - limit))}>← Prev</Link> : null}
      <span>{offset + 1}–{Math.min(total, offset + limit)} of {total.toLocaleString()}</span>
      {offset + limit < total ? <Link className="btn" href={href(offset + limit)}>Next →</Link> : null}
    </div>
  );
}

export function qs(base: Record<string, string | number | undefined>, patch: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) if (v !== undefined && v !== "" && !(k === "offset" && v === 0)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "?";
}
