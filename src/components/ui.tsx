import Link from "next/link";
import type { Greenlight } from "@/src/lib/greenlight";

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

export function VerdictPill({ v, market }: { v: Greenlight | null; market?: string }) {
  if (!v) return <span className="pill pill-mute">{market === "missing" ? "not researched" : "—"}</span>;
  if (v.verdict === "GREENLIGHT") return <span className="pill pill-go">LIST · ${v.profit.toFixed(2)}</span>;
  if (v.verdict === "REJECT") return <span className="pill pill-stop" title={v.reasons.join(" ")}>REJECT · {v.failed.join(", ").replace("_", " ")}</span>;
  return <span className="pill pill-wait" title={v.missing.join(", ")}>NEEDS {v.missing.join(", ").replace(/_/g, " ")}</span>;
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
