import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, hasDatabase } from "@/src/db";
import { mpnDetail } from "@/src/db/queries";
import { HARVEST_LABEL, type HarvestStatus } from "@/src/lib/harvest-candidates";
import { NoDatabase, PageTitle, pct, perSlotDay, QualificationPill, saleDay, usd, Years } from "@/src/components/ui";
import { addAliasAction, saveMarketAction, saveMpnManualAction } from "../../actions";

export const dynamic = "force-dynamic";

const CANDIDATE_PILL: Record<HarvestStatus, string> = { harvest_candidate: "pill-go", test_first: "pill-wait", unavailable: "pill-mute" };

export default async function MpnPage({ params, searchParams }: { params: Promise<{ mpn: string }>; searchParams: Promise<{ availability?: string }> }) {
  if (!hasDatabase()) return <NoDatabase />;
  const { mpn } = await params;
  const { availability: selected } = await searchParams;
  const choice = selected?.trim().toUpperCase();
  const availability = choice === "ELIGIBLE" ? "eligible" : choice === "ALL" ? "all"
    : choice === "INCLUDE_UNCHECKED" ? "include_unchecked" : choice || "eligible";
  const d = await mpnDetail(await getDb(), decodeURIComponent(mpn), availability);
  if (!d) notFound();
  const m = d.mpn;
  const r = d.roadrunner;
  const h = d.harvest;
  const v = (x: string | number | null | undefined) => (x == null ? "" : String(x));
  const q = m.qualification;
  const e = q?.economics ?? null;
  const BASIS: Record<string, string> = {
    market: "market", free_shipping: "free shipping listing", label_estimate: "label estimate (buyer shipping unknown)", default: "default label"
  };

  return (
    <>
      <PageTitle title={m.mpn_display} sub={m.description} />
      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        <QualificationPill v={q} market={m.market} />
        {m.prefilter ? <span className="pill pill-mute">{m.prefilter}</span> : null}
        <span className="text-muted">family {m.part_family}</span>
        <span className="text-muted">· {m.donors} donor machines across {m.models} models</span>
        <span className="text-muted">· removal {m.removal.minutes ?? "?"} min ({m.removal.source ?? "none"}{m.removal.component ? `: ${m.removal.component}` : ""})</span>
        {q?.result === "NOT_QUALIFIED" || q?.result === "QUALIFIED" ? <span className="text-muted">· {q.reasons.join(" ")}</span> : null}
        {q?.result === "SET_RULE" ? <Link className="text-accent underline" href="/settings">Set qualification rules</Link> : null}
      </div>

      {e ? (
        <section className="card mb-5 p-4">
          <h2 className="mb-1 font-semibold">Harvested-part planning economics (Store Economics v7)</h2>
          <p className="mb-3 text-xs text-muted">
            Per-part planning figures from the settings. Buyer shipping {usd(e.B)} ({BASIS[e.buyerShippingBasis]}), shipping label {usd(e.S)} ({BASIS[e.shipLabelBasis]}),
            fees {usd(e.fees)}, pack &amp; ship {usd(e.packShipLabor)}, packaging {usd(e.packaging)}, removal labor {usd(e.removalLabor)},
            machine overhead {usd(e.machineOverhead)} ({e.overheadBasis.toLowerCase()}).
          </p>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            {[
              ["Break-even item price", usd(e.breakEven)],
              ["Projected contribution", usd(e.contribution)],
              ["Projected margin", pct(e.marginPct)],
              ["Over break-even", usd(e.overBreakEven)],
              ["Modeled value / slot-day", q?.modeledValueSlotDay == null ? "needs exact sell-through" : perSlotDay(q.modeledValueSlotDay)]
            ].map(([label, value]) => (
              <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>
            ))}
          </dl>
        </section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">eBay market facts</h2>
          <form action={saveMarketAction} className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <input type="hidden" name="mpn" value={m.mpn_display} />
            {[
              ["sold90", "Sold 90 days", m.sold_90],
              ["sellThroughPct", "Exact-MPN 90-day sell-through %", m.sell_through_pct],
              ["activeQty", "Active listings", m.active_qty],
              ["avgPrice", "Avg sold price $", m.avg_price],
              ["avgShip", "Avg buyer shipping $", m.avg_ship],
              ["qtyOnHand", "Qty on hand / listed", m.qty_on_hand],
              ["shipCost", `Shipping label you pay $ (blank = $${d.settings.defaultShipLabel.toFixed(2)})`, m.ship_cost]
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
              {m.market_source ? <span className="ml-3 text-xs text-muted">source: {m.market_source}</span> : null}
              <span className="ml-3 text-xs text-muted">sell-through: {m.sell_through_source ?? "none (research needed)"}</span></div>
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
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Packaging cost $ (blank = $0)</span>
              <input name="packagingCost" defaultValue={v(m.packaging_cost)} className="input num w-28" />
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" name="forceResearch" defaultChecked={m.force_research} /> Research even if prefilter skips it</label>
            <label className="flex items-center gap-2" title="Waives only the ordinary 90-day sold-count minimum.">
              <input type="checkbox" name="strategicExceptionApproved" defaultChecked={m.strategic_exception_approved} /> Strategic exception approved (sold-count minimum only)
            </label>
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

      <section className="card mt-5 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">Roadrunner sales history</h2>
          {r ? <span className="pill pill-mute">Sold before by Roadrunner</span> : <span className="pill pill-mute">No Roadrunner sales recorded yet</span>}
        </div>
        {r ? (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            {[
              ["Units sold", r.unitsSold],
              ["Sale events", r.saleEvents],
              ["Avg item sale price", r.avgItemPrice == null ? "unknown" : `$${r.avgItemPrice.toFixed(2)}`],
              ["Last sold", saleDay(r.lastSoldAt)],
              ["Avg days to sell", r.avgDaysToSell == null ? "unknown" : `${r.avgDaysToSell} (${r.daysToSellEvents} of ${r.saleEvents} events)`]
            ].map(([label, value]) => (
              <div key={label as string}><dt className="text-xs text-muted">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>
            ))}
          </dl>
        ) : null}
        <p className="mt-2 text-xs text-muted">
          What has actually sold for Roadrunner under {m.mpn_canonical}, from imported sale events
          {r ? ` (source: ${r.sources.join(", ")})` : ""}. Separate from the eBay market facts above. Import on the MPNs page.
        </p>
      </section>

      <section className="card mt-5 overflow-x-auto p-4">
        <h2 className="mb-1 font-semibold">Machine compatibility cross-reference</h2>
        <p className="mb-3 text-xs text-muted">
          One row per machine whose model parts list contains this MPN. Default results include only checked on-hand donors with no recorded part state. UNCHECKED is optional and requires inspection. Historical SOLD and scrap matches remain available for audit only.
        </p>
        <form className="mb-3 flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1"><span className="text-xs text-muted">Machine status</span>
            <select name="availability" defaultValue={availability} className="input">
              <option value="eligible">Eligible checked donors</option>
              <option value="include_unchecked">Checked + UNCHECKED</option>
              <option value="all">All model matches (audit)</option>
              {[...new Set([...d.statusCounts.map((x) => x.availability), availability])].filter((s) => s !== "eligible" && s !== "include_unchecked" && s !== "all").sort().map((s) => (
                <option key={s} value={s}>{s} ({d.statusCounts.find((x) => x.availability === s)?.machines ?? 0})</option>
              ))}
            </select>
          </label>
          <button className="btn">Filter</button>
          <a className="btn" href={`/api/export/mpn-donors?mpn=${encodeURIComponent(m.mpn_canonical)}&availability=${encodeURIComponent(availability)}`}>Export this table CSV</a>
          <span className="text-xs text-muted">{d.machines.length.toLocaleString()} matching machines</span>
        </form>
        <dl className="mb-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          {[
            ["Harvest candidates now", h.counts.harvestCandidates],
            ["Test first", h.counts.testFirst],
            ["Processed / not available", h.counts.unavailable],
            ["Models represented", h.counts.models],
            ["Default checked donor supply", m.donors]
          ].map(([label, value]) => (
            <div key={label as string}><dt className="text-xs text-muted">{label}</dt><dd className="text-lg font-semibold tabular-nums">{value}</dd></div>
          ))}
        </dl>
        <table className="w-full text-sm">
          <thead><tr><th>Candidate</th><th>#</th><th>Status</th><th>Type</th><th>Brand</th><th>Model</th><th>Diagram</th><th>Possible years</th><th>Part state</th><th>Reason</th></tr></thead>
          <tbody>
            {[...h.harvestCandidates, ...h.testFirst, ...h.unavailable].map((x) => (
              <tr key={x.machine_no} className={x.candidate === "unavailable" ? "opacity-50" : ""}>
                <td><span className={`pill ${CANDIDATE_PILL[x.candidate]}`}>{HARVEST_LABEL[x.candidate]}</span></td>
                <td><Link className="mono text-accent hover:underline" href={`/machines/${encodeURIComponent(x.machine_no)}`}>{x.machine_no}</Link></td>
                <td className="text-xs">{x.availability}</td>
                <td className="text-xs">{x.appliance_type}</td>
                <td>{x.brand}</td>
                <td className="mono">{x.model_raw}</td>
                <td className="text-xs">{x.diagram_id}</td>
                <td className="text-xs"><Years years={x.age_candidate_years} /></td>
                <td>{x.state ? <span className="pill pill-mute">{x.state}</span> : null}</td>
                <td className="text-xs text-muted">{x.reasons.join(" ")}</td>
              </tr>
            ))}
            {!d.machines.length ? <tr><td colSpan={10} className="py-6 text-center text-muted">No machines match this status filter.</td></tr> : null}
          </tbody>
        </table>
        {h.counts.testFirst ? <p className="mt-2 text-xs text-muted">Test-first machines require inspection before the part can be counted as harvestable.</p> : null}
        <p className="mt-2 text-xs text-muted">Found in {d.models.length} model parts lists: {d.models.slice(0, 40).map((x) => x.model_key).join(", ")}{d.models.length > 40 ? " …" : ""}</p>
      </section>
    </>
  );
}
