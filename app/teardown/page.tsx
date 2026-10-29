import Link from "next/link";
import { getDb, hasDatabase } from "@/src/db";
import { physicalReviewCount, physicalReviewQueue, teardownQueue } from "@/src/db/queries";
import { NoDatabase, PageTitle, Pager, pct, perSlotDay, qs, usd, Years } from "@/src/components/ui";

export const dynamic = "force-dynamic";

export default async function TeardownPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!hasDatabase()) return <NoDatabase />;
  const db = await getDb();
  const sp = await searchParams;
  const requested = Number(sp.offset ?? 0);
  const pageSize = 150;
  const { status, rows, qualified } = await teardownQueue(db, 150);
  const physicalTotal = status === "set_rule" ? await physicalReviewCount(db) : 0;
  const offset = Number.isFinite(requested) && requested >= 0
    ? Math.min(Math.trunc(requested), Math.max(0, Math.ceil(physicalTotal / pageSize) - 1) * pageSize) : 0;
  const physical = status === "set_rule" ? await physicalReviewQueue(db, pageSize, offset) : [];
  return (
    <>
      <PageTitle
        title="Teardown queue"
        sub="Review parts on available donor machines. When qualification rules are configured, qualified parts are ranked by modeled value / slot-day. Parts matching a machine's failure symptom are marked test first."
      />
      {status === "set_rule" ? (
        <>
          <div className="card mb-4 flex flex-wrap items-center gap-3 p-4 text-sm">
            <span className="mr-auto">{physicalTotal.toLocaleString()} donor machines with parts to review. This is a physical worklist, with no economic qualification or pull recommendation.</span>
            <a className="btn btn-primary" href="/api/export/teardown">Export review CSV</a>
            <p className="basis-full text-xs text-muted">Optional: set sell-through and margin thresholds in <Link className="underline" href="/settings">Settings</Link> to enable qualified ranking.</p>
          </div>
          {physical.length ? (
            <div className="card overflow-x-auto p-4">
              <table className="w-full text-sm">
                <thead><tr><th>Machine</th><th>Status</th><th>Location</th><th>Brand</th><th>Model</th><th>MPN</th><th>Description</th><th>Diagram</th><th>Review</th></tr></thead>
                <tbody>{physical.flatMap((machine) => machine.lines.map((line) => (
                  <tr key={`${machine.machine_no}:${line.mpn_canonical}`}>
                    <td><Link className="mono text-accent hover:underline" href={`/machines/${encodeURIComponent(machine.machine_no)}`}>{machine.machine_no}</Link></td>
                    <td>{machine.availability}</td><td className="mono text-xs">{machine.location || "—"}</td><td>{machine.brand}</td><td className="mono">{machine.model_raw}</td>
                    <td><Link className="mono text-accent hover:underline" href={`/mpns/${encodeURIComponent(line.mpn_canonical)}`}>{line.mpn_display}</Link></td>
                    <td>{line.description}</td><td>{line.diagram_id}</td>
                    <td><span className={`pill ${line.action === "test_first" ? "pill-wait" : "pill-mute"}`}>{line.action === "test_first" ? "test first" : "review"}</span></td>
                  </tr>
                )))}</tbody>
              </table>
            </div>
          ) : <div className="card p-5 text-sm text-muted">No parts to review yet. Import machines and read their model parts lists first.</div>}
          {physicalTotal > pageSize ? <Pager total={physicalTotal} limit={pageSize} offset={offset} href={(o) => qs({}, { offset: o })} /> : null}
        </>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3 text-sm">
            <span className="text-muted">{qualified} qualified MPNs · {rows.length} machines with parts to pull</span>
            <a className="btn btn-primary ml-auto" href="/api/export/teardown">Export pick list CSV</a>
          </div>
          {!rows.length ? (
            <div className="card p-5 text-sm text-muted">Nothing to pull yet. Read parts lists, research the queue on eBay, then import the market facts.</div>
          ) : (
            <ol className="space-y-3">
              {rows.map((m, i) => (
                <li key={m.machine_no} className="card p-3">
                  <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-muted tabular-nums">{i + 1}.</span>
                    <Link className="mono font-semibold text-accent hover:underline" href={`/machines/${encodeURIComponent(m.machine_no)}`}>#{m.machine_no}</Link>
                    <span>{m.brand} <span className="mono">{m.model_raw}</span></span>
                    <span className="mono text-xs text-muted">Location: {m.location || "unassigned"}</span>
                    <span className="text-xs text-muted">{m.appliance_type} · {m.availability} · <Years years={m.age_candidate_years} /></span>
                    <span className="ml-auto text-xs text-muted">{m.lines.length} qualified part{m.lines.length === 1 ? "" : "s"}</span>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted">
                        <th>MPN</th><th>Description</th><th>Diagram</th><th className="num">Removal</th><th className="num">Break-even</th>
                        <th className="num">Contribution</th><th className="num">Margin</th><th className="num">Value/slot-day</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.lines.map((l) => (
                        <tr key={l.mpn_canonical}>
                          <td className="w-32 mono">{l.mpn_display}</td><td>{l.description}</td><td className="w-40 text-xs text-muted">{l.diagram_id}</td>
                          <td className="num w-20">{l.removal_min ?? "?"} min</td><td className="num">{usd(l.break_even)}</td>
                          <td className="num">{usd(l.contribution)}</td><td className="num">{pct(l.margin_pct)}</td><td className="num">{perSlotDay(l.modeled_value_slot_day)}</td>
                        </tr>
                      ))}
                      {m.suspect_lines.map((l) => (
                        <tr key={l.mpn_canonical} className="text-wait">
                          <td className="mono">{l.mpn_display}</td><td>{l.description} <span className="pill pill-wait">test first</span></td><td className="text-xs">{l.diagram_id}</td>
                          <td className="num">{l.removal_min ?? "?"} min</td><td className="num">{usd(l.break_even)}</td>
                          <td className="num">({usd(l.contribution)})</td><td className="num">{pct(l.margin_pct)}</td><td className="num">—</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </>
  );
}
