import { getDb, hasDatabase } from "@/src/db";
import { getBaselines, getSettings, rulesSet } from "@/src/db/queries";
import { knownComponents, LIBRARY_APPLIANCES } from "@/src/lib/part-family";
import { NoDatabase, PageTitle } from "@/src/components/ui";
import { saveBaselineAction, saveSettingsAction } from "../actions";

export const dynamic = "force-dynamic";

type Field = [name: string, label: string, value: number | string | null];

function Fields({ title, note, fields }: { title: string; note?: string; fields: Field[] }) {
  return (
    <fieldset className="col-span-full">
      <legend className="mb-1 text-sm font-semibold">{title}</legend>
      {note ? <p className="mb-2 text-xs text-muted">{note}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {fields.map(([name, label, value]) => (
          <label key={name} className="flex flex-col gap-1">
            <span className="text-xs text-muted">{label}</span>
            <input name={name} defaultValue={value == null ? "" : String(value)} placeholder={value == null ? "not set" : undefined} className="input num" />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default async function SettingsPage() {
  if (!hasDatabase()) return <NoDatabase />;
  const db = await getDb();
  const [s, baselines] = await Promise.all([getSettings(db), getBaselines(db)]);
  const o = s.harvestOverhead;
  const have = new Map(baselines.map((b) => [`${b.appliance}|${b.component}`, b.minutes]));

  return (
    <>
      <PageTitle
        title="Settings"
        sub="Every number the qualification uses. Nothing is hard-coded. The current model is Roadrunner Store Economics v7: there is no general minimum part price; the floor is each part's break-even."
      />
      <section className="card mb-6 p-4">
        <form action={saveSettingsAction} className="grid gap-5 text-sm">
          <Fields
            title="Qualification rules (owner-set)"
            note={rulesSet(s)
              ? "Both set. Leave a field blank to unset it; qualification then returns SET RULE."
              : "Optional and blank until you choose them. While either is blank, every researched MPN shows SET RULE and teardown ranking is off."}
            fields={[
              ["minimumSellThroughPct", "Minimum exact-MPN 90-day sell-through %", s.minimumSellThroughPct],
              ["minimumProfitMarginPct", "Minimum projected profit margin %", s.minimumProfitMarginPct],
              ["ordinarySold90Minimum", "Ordinary 90-day sold minimum (strategic exception waives)", s.ordinarySold90Minimum]
            ]}
          />
          <Fields
            title="Store Economics v7 planning assumptions"
            note="Buyer-paid shipping is revenue; the shipping label is still a seller cost. Management labor is not charged per part."
            fields={[
              ["finalValueFeePct", "Final value fee %", s.finalValueFeePct],
              ["promotedListingPct", "Promoted listing estimate %", s.promotedListingPct],
              ["marketplaceTaxPct", "Marketplace tax % (on ex-tax revenue)", s.marketplaceTaxPct],
              ["perOrderFee", "Per-order fee $", s.perOrderFee],
              ["defaultShipLabel", "Default outbound shipping label $", s.defaultShipLabel],
              ["packShipLabor", "Pack & ship labor per order $", s.packShipLabor],
              ["laborRateHr", "Operations labor $/hour", s.laborRateHr]
            ]}
          />
          <Fields
            title="Machine-type overhead per quick-sale harvested part $"
            fields={[
              ["overheadRefrigerator", "Refrigerator", o.Refrigerator],
              ["overheadWasher", "Washer", o.Washer],
              ["overheadRange", "Range", o.Range],
              ["overheadDryer", "Dryer", o.Dryer],
              ["overheadDishwasher", "Dishwasher", o.Dishwasher],
              ["overheadFallback", "Other / unresolved type", o.fallback]
            ]}
          />
          <Fields
            title="Other"
            fields={[
              ["machineOverhead", "Whole-machine acquisition overhead $ (not used in part qualification)", s.machineOverhead],
              ["marketStaleDays", "Research is stale after days", s.marketStaleDays],
              ["batchSize", "Parts-list batch size", s.batchSize]
            ]}
          />
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Statuses that count as donor machines (comma separated)</span>
            <input name="donorAvailabilities" defaultValue={s.donorAvailabilities.join(", ")} className="input" />
          </label>
          <div><button className="btn btn-primary">Save settings</button></div>
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
