import { getDb, hasDatabase } from "@/src/db";
import { getBaselines, getSettings } from "@/src/db/queries";
import { knownComponents, LIBRARY_APPLIANCES } from "@/src/lib/part-family";
import { NoDatabase, PageTitle } from "@/src/components/ui";
import { saveBaselineAction, saveSettingsAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  if (!hasDatabase()) return <NoDatabase />;
  const db = await getDb();
  const [s, baselines] = await Promise.all([getSettings(db), getBaselines(db)]);
  const fields: Array<[string, string, number | string]> = [
    ["feePct", "eBay fee % (all-in)", s.feePct],
    ["minSellThroughPct", "Minimum 90-day sell-through %", s.minSellThroughPct],
    ["minProfit", "Minimum profit $", s.minProfit],
    ["harvestCushion", "Harvested-part cushion $", s.harvestCushion],
    ["laborRateHr", "Labor $/hr", s.laborRateHr],
    ["defaultShipCost", "Default ship cost you pay $", s.defaultShipCost],
    ["machineOverhead", "Machine overhead $ (buying only)", s.machineOverhead],
    ["stockWindowDays", "Stock window days (pull cap)", s.stockWindowDays],
    ["marketStaleDays", "Research is stale after days", s.marketStaleDays],
    ["batchSize", "Parts-list batch size", s.batchSize]
  ];
  const have = new Map(baselines.map((b) => [`${b.appliance}|${b.component}`, b.minutes]));

  return (
    <>
      <PageTitle title="Settings" sub="Every threshold the verdicts use. Nothing is hard-coded." />
      <section className="card mb-6 p-4">
        <form action={saveSettingsAction} className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
          {fields.map(([name, label, value]) => (
            <label key={name} className="flex flex-col gap-1">
              <span className="text-xs text-muted">{label}</span>
              <input name={name} defaultValue={String(value)} className="input num" />
            </label>
          ))}
          <label className="col-span-full flex flex-col gap-1">
            <span className="text-xs text-muted">Statuses that count as donor machines (comma separated)</span>
            <input name="donorAvailabilities" defaultValue={s.donorAvailabilities.join(", ")} className="input" />
          </label>
          <div className="col-span-full"><button className="btn btn-primary">Save settings</button></div>
        </form>
      </section>

      <section className="card p-4">
        <h2 className="mb-1 font-semibold">Removal minutes by component</h2>
        <p className="mb-3 text-xs text-muted">
          Seeded from the Store Economics Removal Time Library. Order used: your manual minutes on a part → researched exact-MPN → this table.
          Blank means unknown, and parts of that kind answer NEEDS DATA instead of guessing. Dishwasher and microwave have no baselines yet.
        </p>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {LIBRARY_APPLIANCES.map((a) => (
            <div key={a}>
              <h3 className="mb-1 text-sm font-semibold">{a}</h3>
              <table className="w-full text-sm">
                <tbody>
                  {knownComponents(a).map((c) => (
                    <tr key={c}>
                      <td>{c}</td>
                      <td className="w-36">
                        <form action={saveBaselineAction} className="flex gap-1">
                          <input type="hidden" name="appliance" value={a} />
                          <input type="hidden" name="component" value={c} />
                          <input name="minutes" defaultValue={have.get(`${a}|${c}`) ?? ""} className={`input num w-16 ${have.has(`${a}|${c}`) ? "" : "border-wait"}`} />
                          <button className="btn px-2 py-0.5 text-xs">Set</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
