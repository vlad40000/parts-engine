import Link from "next/link";
import { getDb, hasDatabase } from "@/src/db";
import { teardownQueue } from "@/src/db/queries";
import { NoDatabase, PageTitle, pct, perSlotDay, usd, Years } from "@/src/components/ui";

export const dynamic = "force-dynamic";

export default async function TeardownPage() {
  if (!hasDatabase()) return <NoDatabase />;
  const { status, rows, qualified } = await teardownQueue(await getDb(), 150);
  return (
    <>
      <PageTitle
        title="Teardown queue"
        sub="Machines holding QUALIFIED parts (Store Economics v7), ordered by the modeled value / slot-day of those parts. That ordering metric is not a profit score or a probability, and no stock target or pull cap is applied. Parts matching a machine's failure symptom are shown as test first and not counted."
      />
      {status === "set_rule" ? (
        <div className="card p-5 text-sm text-wait">
          Set qualification rules. Automated teardown ranking is off until the owner enters the minimum 90-day sell-through % and
          minimum projected profit margin % in <Link className="underline" href="/settings">Settings</Link>.
        </div>
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
