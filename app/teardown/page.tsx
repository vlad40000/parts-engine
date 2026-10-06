import Link from "next/link";
import { getDb, hasDatabase } from "@/src/db";
import { teardownQueue } from "@/src/db/queries";
import { NoDatabase, PageTitle, Years } from "@/src/components/ui";

export const dynamic = "force-dynamic";

export default async function TeardownPage() {
  if (!hasDatabase()) return <NoDatabase />;
  const { rows, greenlit, settings } = await teardownQueue(await getDb(), 150);
  return (
    <>
      <PageTitle
        title="Teardown queue"
        sub={`Machines ranked by the profit of greenlit parts still inside them. Each part is capped at what ~${settings.stockWindowDays} days of demand can absorb, minus what you already hold; the rest stays in the yard. Parts matching a machine's failure symptom are shown as test first and not counted.`}
      />
      <div className="mb-4 flex items-center gap-3 text-sm">
        <span className="text-muted">{greenlit} greenlit MPNs · {rows.length} machines with parts to pull</span>
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
                <span className="ml-auto text-lg font-semibold tabular-nums">${m.score.toFixed(2)}</span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {m.lines.map((l) => (
                    <tr key={l.mpn_canonical}>
                      <td className="w-32 mono">{l.mpn_display}</td><td>{l.description}</td><td className="w-40 text-xs text-muted">{l.diagram_id}</td>
                      <td className="num w-20">{l.removal_min ?? "?"} min</td><td className="num w-24">${l.profit.toFixed(2)}</td>
                    </tr>
                  ))}
                  {m.suspect_lines.map((l) => (
                    <tr key={l.mpn_canonical} className="text-wait">
                      <td className="mono">{l.mpn_display}</td><td>{l.description} <span className="pill pill-wait">test first</span></td><td className="text-xs">{l.diagram_id}</td>
                      <td className="num">{l.removal_min ?? "?"} min</td><td className="num">(${l.profit.toFixed(2)})</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
