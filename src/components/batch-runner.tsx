"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type Candidate = { brand_key: string; model_key: string; brand: string; model: string; machines: number; types: string; bom_status: string | null };

type JobState = "running" | "found" | "not_found" | "error" | "canceled";
type Job = {
  key: string;
  brand: string;
  model: string;
  machines: number | null;
  state: JobState;
  startedAt: number;
  finishedAt?: number;
  result?: { supplier: string | null; rows: number; newMpns: number; dropped: number; attempts: Array<{ supplier: string; status: string; warnings: string[] }> };
  message?: string;
};

const keyOf = (brand: string, model: string) => `${brand.trim().toUpperCase()}::${model.trim().toUpperCase()}`;

export function BatchRunner({ candidates, batchSize }: { candidates: Candidate[]; batchSize: number }) {
  const router = useRouter();
  const controllers = useRef(new Map<string, AbortController>());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  const running = jobs.filter((j) => j.state === "running").length;
  const doneKeys = new Set(jobs.filter((j) => j.state !== "canceled" && j.state !== "error").map((j) => j.key));

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => () => controllers.current.forEach((c) => c.abort()), []);

  function toggle(key: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else if (next.size < batchSize) next.add(key);
      return next;
    });
  }

  function selectNext() {
    const next = new Set<string>();
    for (const c of candidates) {
      const k = keyOf(c.brand, c.model);
      if (doneKeys.has(k)) continue;
      next.add(k);
      if (next.size >= batchSize) break;
    }
    setSelected(next);
  }

  function start(brand: string, model: string, machines: number | null) {
    const key = keyOf(brand, model);
    controllers.current.get(key)?.abort();
    const controller = new AbortController();
    controllers.current.set(key, controller);
    const job: Job = { key, brand, model, machines, state: "running", startedAt: Date.now() };
    setJobs((cur) => [job, ...cur.filter((j) => j.key !== key)]);
    fetch("/api/bom/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brand, model }),
      signal: controller.signal
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) throw new Error(data?.error ?? `HTTP ${res.status}`);
        setJobs((cur) => cur.map((j) => (j.key === key ? { ...j, state: data.status as JobState, finishedAt: Date.now(), result: data } : j)));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setJobs((cur) => cur.map((j) => (j.key === key ? { ...j, state: "error", finishedAt: Date.now(), message: err instanceof Error ? err.message : String(err) } : j)));
      })
      .finally(() => {
        if (controllers.current.get(key) === controller) controllers.current.delete(key);
        if (controllers.current.size === 0) router.refresh();
      });
  }

  function runSelected() {
    setError("");
    const chosen = candidates.filter((c) => selected.has(keyOf(c.brand, c.model)));
    const pasted = paste
      .split(/\r?\n/)
      .map((l) => l.split(/[,\t]/).map((x) => x.trim()))
      .filter((p) => p[0] && p[1]);
    const total = chosen.length + pasted.length;
    if (!total) return setError("Select models or paste lines like: GE, GDT535PSJ2SS");
    if (total > batchSize) return setError(`Run up to ${batchSize} models at a time (Settings → batch size).`);
    chosen.forEach((c) => start(c.brand, c.model, c.machines));
    pasted.forEach(([b, m]) => start(b, m, null));
    setSelected(new Set());
    setPaste("");
  }

  function cancel(key: string) {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setJobs((cur) => cur.map((j) => (j.key === key && j.state === "running" ? { ...j, state: "canceled", finishedAt: Date.now() } : j)));
  }

  const totals = jobs.reduce((t, j) => ({ rows: t.rows + (j.result?.rows ?? 0), mpns: t.mpns + (j.result?.newMpns ?? 0) }), { rows: 0, mpns: 0 });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto font-semibold">Models without a parts list</h2>
          <button className="btn" onClick={selectNext} type="button">Select next {batchSize}</button>
          <button className="btn btn-primary" onClick={runSelected} disabled={!selected.size && !paste.trim()} type="button">
            Run {selected.size || ""} {selected.size === 1 ? "model" : "models"}
          </button>
        </div>
        <p className="mb-2 text-xs text-muted">{selected.size}/{batchSize} selected · most machines first, so one lookup covers the most units.</p>
        {error ? <p className="mb-2 text-sm text-stop">{error}</p> : null}
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead><tr><th></th><th>Brand</th><th>Model</th><th className="num">Machines</th><th>Type</th></tr></thead>
            <tbody>
              {candidates.map((c) => {
                const k = keyOf(c.brand, c.model);
                const done = doneKeys.has(k);
                return (
                  <tr key={k} className={done ? "opacity-40" : ""}>
                    <td><input type="checkbox" checked={selected.has(k)} disabled={done || (!selected.has(k) && selected.size >= batchSize)} onChange={() => toggle(k)} /></td>
                    <td>{c.brand}</td>
                    <td className="mono">{c.model}{c.bom_status === "error" ? <span className="pill pill-stop ml-2">retry</span> : null}</td>
                    <td className="num">{c.machines}</td>
                    <td className="text-xs text-muted">{c.types}</td>
                  </tr>
                );
              })}
              {!candidates.length ? <tr><td colSpan={5} className="py-6 text-center text-muted">Every donor model in this filter has a parts list.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted">Paste models instead</summary>
          <textarea className="input mt-2 h-28 w-full mono" placeholder={"GE, GDT535PSJ2SS\nWhirlpool, WTW5000DW1"} value={paste} onChange={(e) => setPaste(e.target.value)} />
        </details>
      </section>

      <section className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="mr-auto font-semibold">Batch</h2>
          {running ? <button className="btn" type="button" onClick={() => jobs.forEach((j) => j.state === "running" && cancel(j.key))}>Cancel all</button> : null}
        </div>
        <p className="mb-3 text-xs text-muted">
          {running ? `${running} running · ` : ""}{totals.rows.toLocaleString()} parts read · {totals.mpns.toLocaleString()} new MPNs this session.
          {" "}Lookup order: Encompass → AppliancePartsPros. HTML only, no AI.
        </p>
        <ul className="space-y-2">
          {jobs.map((j) => {
            const secs = Math.round(((j.finishedAt ?? now) - j.startedAt) / 1000);
            return (
              <li key={j.key} className="rounded border border-line p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{j.brand}</span>
                  <span className="mono">{j.model}</span>
                  {j.machines ? <span className="text-xs text-muted">{j.machines} machines</span> : null}
                  <span className="ml-auto text-xs text-muted tabular-nums">{secs}s</span>
                  {j.state === "running" ? <span className="pill pill-wait">reading…</span> : null}
                  {j.state === "found" ? <span className="pill pill-go">{j.result?.rows} parts · {j.result?.supplier}</span> : null}
                  {j.state === "not_found" ? <span className="pill pill-mute">not found</span> : null}
                  {j.state === "error" ? <span className="pill pill-stop">error</span> : null}
                  {j.state === "canceled" ? <span className="pill pill-mute">canceled</span> : null}
                  {j.state === "running"
                    ? <button className="btn" type="button" onClick={() => cancel(j.key)}>Cancel</button>
                    : j.state !== "found" ? <button className="btn" type="button" onClick={() => start(j.brand, j.model, j.machines)}>Retry</button> : null}
                </div>
                {j.result?.newMpns ? <div className="mt-1 text-xs text-muted">{j.result.newMpns} MPNs not seen before{j.result.dropped ? ` · ${j.result.dropped} rows had no OEM number` : ""}</div> : null}
                {j.message ? <div className="mt-1 text-xs text-stop">{j.message}</div> : null}
                {j.result && j.state !== "found" ? (
                  <ul className="mt-1 text-xs text-muted">
                    {j.result.attempts.map((a) => <li key={a.supplier}>{a.supplier}: {a.status}{a.warnings.length ? ` — ${a.warnings.slice(0, 2).join(" ")}` : ""}</li>)}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {!jobs.length ? <li className="py-6 text-center text-sm text-muted">Select up to {batchSize} models and press Run. Each model is read once and reused by every machine of that model.</li> : null}
        </ul>
        {jobs.some((j) => j.state === "found") ? <div className="mt-3 text-sm"><Link className="btn" href="/mpns?view=queue">Open research queue →</Link></div> : null}
      </section>
    </div>
  );
}
