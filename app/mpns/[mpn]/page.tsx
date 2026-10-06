import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, hasDatabase } from "@/src/db";
import { mpnDetail } from "@/src/db/queries";
import { NoDatabase, PageTitle, VerdictPill, Years } from "@/src/components/ui";
import { addAliasAction, saveMarketAction, saveMpnManualAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function MpnPage({ params }: { params: Promise<{ mpn: string }> }) {
  if (!hasDatabase()) return <NoDatabase />;
  const { mpn } = await params;
  const d = await mpnDetail(await getDb(), decodeURIComponent(mpn));
  if (!d) notFound();
  const m = d.mpn;
  const v = (x: string | number | null | undefined) => (x == null ? "" : String(x));

  return (
    <>
      <PageTitle title={m.mpn_display} sub={m.description} />
      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        <VerdictPill v={m.verdict} market={m.market} />
        {m.prefilter ? <span className="pill pill-mute">{m.prefilter}</span> : null}
        <span className="text-muted">family {m.part_family}</span>
        <span className="text-muted">· {m.donors} donor machines across {m.models} models</span>
        <span className="text-muted">· removal {m.removal.minutes ?? "?"} min ({m.removal.source ?? "none"}{m.removal.component ? `: ${m.removal.component}` : ""})</span>
        {m.verdict?.verdict === "REJECT" || m.verdict?.verdict === "GREENLIGHT" ? <span className="text-muted">· {m.verdict.reasons.join(" ")}</span> : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">eBay market facts</h2>
          <form action={saveMarketAction} className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <input type="hidden" name="mpn" value={m.mpn_display} />
            {[
              ["sold90", "Sold 90 days", m.sold_90],
              ["sellThroughPct", "Sell-through %", m.sell_through_pct],
              ["activeQty", "Active listings", m.active_qty],
              ["avgPrice", "Avg sold price $", m.avg_price],
              ["avgShip", "Avg buyer shipping $", m.avg_ship],
              ["qtyOnHand", "Qty on hand / listed", m.qty_on_hand],
              ["shipCost", "Your ship cost $ (free ship)", m.ship_cost]
            ].map(([name, label, value]) => (
              <label key={name as string} className="flex flex-col gap-1">
                <span className="text-xs text-muted">{label}</span>
                <input name={name as string} defaultValue={v(value as string | number | null)} className="input num" />
              </label>
            ))}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Researched on</span>
              <input type="date" name="researchedAt" defaultValue={m.researched_at ?? new Date().toISOString().slice(0, 10)} className="input" />
            </label>
            <label className="flex items-center gap-2 self-end">
              <input type="checkbox" name="freeShipping" defaultChecked={Boolean(m.free_shipping)} /> <span>Free shipping listing</span>
            </label>
            <div className="col-span-full"><button className="btn btn-primary">Save market facts</button>
              {m.market_source ? <span className="ml-3 text-xs text-muted">source: {m.market_source}</span> : null}</div>
          </form>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Part settings</h2>
          <form action={saveMpnManualAction} className="flex flex-wrap items-end gap-3 text-sm">
            <input type="hidden" name="mpn" value={m.mpn_canonical} />
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Removal minutes (blank = library)</span>
              <input name="removalMin" defaultValue={m.removal_source === "manual" ? v(m.removal_min) : ""} placeholder={v(m.removal.minutes)} className="input num w-28" />
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" name="forceResearch" defaultChecked={m.force_research} /> Research even if prefilter skips it</label>
            <button className="btn">Save</button>
          </form>
          <h3 className="mb-2 mt-5 text-sm font-semibold">Aliases</h3>
          <ul className="mb-2 text-sm">
            {d.aliases.map((a) => <li key={a.aliasCanonical} className="mono">{a.aliasCanonical} <span className="text-xs text-muted">({a.kind}, {a.source})</span></li>)}
            {!d.aliases.length ? <li className="text-xs text-muted">None. Add old or replaced numbers so sales and research under them land here.</li> : null}
          </ul>
          <form action={addAliasAction} className="flex flex-wrap gap-2 text-sm">
            <input type="hidden" name="target" value={m.mpn_canonical} />
            <input name="alias" placeholder="Old / other MPN" className="input mono w-40" required />
            <select name="kind" className="input"><option value="supersedes">replaced by this</option><option value="variant">variant / typo</option><option value="wp_prefix">WP prefix</option></select>
            <button className="btn">Add alias</button>
          </form>
        </section>
      </div>

      <section className="card mt-5 overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">Machines on the lot that contain this part</h2>
        <table className="w-full text-sm">
          <thead><tr><th>#</th><th>Status</th><th>Type</th><th>Brand</th><th>Model</th><th>Diagram</th><th>Possible years</th><th>Part state</th></tr></thead>
          <tbody>
            {d.machines.map((x) => (
              <tr key={x.machine_no} className={x.state || !d.settings.donorAvailabilities.includes(x.availability) ? "opacity-50" : ""}>
                <td><Link className="mono text-accent hover:underline" href={`/machines/${encodeURIComponent(x.machine_no)}`}>{x.machine_no}</Link></td>
                <td className="text-xs">{x.availability}</td>
                <td className="text-xs">{x.appliance_type}</td>
                <td>{x.brand}</td>
                <td className="mono">{x.model_raw}</td>
                <td className="text-xs">{x.diagram_id}</td>
                <td className="text-xs"><Years years={x.age_candidate_years} /></td>
                <td>{x.state ? <span className="pill pill-mute">{x.state}</span> : x.suspect_families.includes(m.part_family) ? <span className="pill pill-wait">test first</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">Found in {d.models.length} model parts lists: {d.models.slice(0, 40).map((x) => x.model_key).join(", ")}{d.models.length > 40 ? " …" : ""}</p>
      </section>
    </>
  );
}
