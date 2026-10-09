import Link from "next/link";
import { getDb, hasDatabase } from "@/src/db";
import { mpnIndex, type MpnFilter } from "@/src/db/queries";
import { PART_FAMILIES } from "@/src/lib/part-family";
import { NoDatabase, PageTitle, Pager, QualificationPill, perSlotDay, qs, usd } from "@/src/components/ui";
import { ButtonForm, UploadForm } from "@/src/components/forms";
import { EBAYDECISIONS_MAX_MPNS, isEbayDecisionsConfigured } from "@/src/lib/ebaydecisions";
import { SALES_HEADERS } from "@/src/lib/sales-import";
import { SHARED_RESEARCH_CSV_HEADERS } from "@/src/lib/shared-research-csv";
import { importMarketAction, importSalesAction, refreshMarketFactsAction } from "../actions";

export const dynamic = "force-dynamic";
type SP = Promise<Record<string, string | undefined>>;

const VIEWS: Array<{ key: NonNullable<MpnFilter["view"]>; label: string }> = [
  { key: "queue", label: "Research queue" },
  { key: "qualified", label: "Qualified" },
  { key: "needs_data", label: "Needs data" },
  { key: "not_qualified", label: "Not qualified" },
  { key: "set_rule", label: "Set rule" },
  { key: "prefiltered", label: "Skipped before research" },
  { key: "all", label: "All" }
];

export default async function MpnsPage({ searchParams }: { searchParams: SP }) {
  if (!hasDatabase()) return <NoDatabase />;
  const sp = await searchParams;
  const view = (sp.view as MpnFilter["view"]) ?? "queue";
  const offset = Number(sp.offset ?? 0) || 0;
  const { rows, total, settings, rulesSet } = await mpnIndex(await getDb(), { view, family: sp.family, q: sp.q }, 100, offset);
  const base = { view, family: sp.family, q: sp.q };

  return (
    <>
      <PageTitle
        title="MPNs"
        sub={<>Every part number found in your parts lists. <b>Donors</b> counts machines on the lot that still hold the part, across every model that uses it — that is the compatibility cross-reference, built from your own parts lists. Qualification follows Store Economics v7:
          sold ≥ {settings.ordinarySold90Minimum} in 90 days (or a strategic exception), exact-MPN sell-through and projected margin at or above
          the owner-set minimums, and price at or above the per-part break-even. There is no general minimum part price.</>}
      />
      {!rulesSet ? (
        <div className="card mb-4 p-3 text-sm text-wait">
          Set qualification rules: the minimum 90-day sell-through % and minimum projected profit margin % are blank, so every
          researched MPN shows SET RULE. Enter both in <Link className="underline" href="/settings">Settings</Link>.
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-1 text-sm">
        {VIEWS.map((v) => (
          <Link key={v.key} href={qs({}, { view: v.key, family: sp.family, q: sp.q })}
            className={`rounded px-3 py-1 ${view === v.key ? "bg-ink text-white" : "border border-line bg-white hover:border-ink"}`}>
            {v.label}
          </Link>
        ))}
        <form className="ml-auto flex gap-2">
          <input type="hidden" name="view" value={view} />
          <input name="q" defaultValue={sp.q ?? ""} placeholder="MPN or description" className="input w-48" />
          <select name="family" defaultValue={sp.family ?? ""} className="input">
            <option value="">Any family</option>
            {PART_FAMILIES.map((f) => <option key={f}>{f}</option>)}
          </select>
          <button className="btn">Filter</button>
        </form>
      </div>

      {view === "queue" ? (
        <div className="card mb-4 flex flex-wrap items-center gap-3 p-3 text-sm">
          <span className="mr-auto text-muted">Not yet researched (or stale over {settings.marketStaleDays} days), with at least one donor, ordered by donors.</span>
          <a className="btn btn-primary" href="/api/export/research-queue">Export queue CSV</a>
          <ol className="basis-full list-decimal pl-5 text-xs text-muted">
            <li><b>Export queue CSV</b>: the shared research CSV, with New Price filled in where Parts Engine knows it and the research columns blank.</li>
            <li>Research each MPN in eBay Product Research and fill in its row. Leave a cell blank when you have no value; blank stays unknown, never zero.</li>
            <li>Upload the completed file below with <b>Import market facts</b>, as is. The same file also imports into EbayDecisions (Settings → Shared research CSV).</li>
          </ol>
          <div className="basis-full">
            {isEbayDecisionsConfigured() ? (
              rows.length ? (
                <>
                  <ButtonForm action={refreshMarketFactsAction} label="Refresh market facts from EbayDecisions" pendingLabel="Asking EbayDecisions…">
                    {/* Only the MPNs rendered on this page, one batch; the API key never leaves the server. */}
                    {rows.slice(0, EBAYDECISIONS_MAX_MPNS).map((r) => <input key={r.mpn_canonical} type="hidden" name="mpn" value={r.mpn_canonical} />)}
                  </ButtonForm>
                  <p className="mt-1 text-xs text-muted">Reads facts already stored in EbayDecisions for every MPN on this page, for research imported there. No registration, no research.</p>
                </>
              ) : null
            ) : (
              <span className="text-xs text-muted">Live EbayDecisions refresh is not configured (EBAYDECISIONS_URL and EBAYDECISIONS_API_KEY). Use the CSV export and the market facts import below.</span>
            )}
          </div>
        </div>
      ) : null}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th>MPN</th><th>Description</th><th>Family</th><th className="num">Donors</th><th className="num">Models</th>
              <th className="num">New $</th><th className="num">Min</th><th className="num">Sold 90d</th><th className="num">STR %</th>
              <th className="num">Active</th><th className="num">Avg $</th><th className="num">Break-even</th><th>Qualification</th>
              <th className="num" title="(price − break-even) × exact sell-through ÷ 90. A ranking metric, not a probability.">Value/slot-day</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.mpn_canonical}>
                <td><Link className="mono text-accent hover:underline" href={`/mpns/${encodeURIComponent(r.mpn_canonical)}`}>{r.mpn_display}</Link></td>
                <td className="max-w-72 truncate" title={r.description}>{r.description}</td>
                <td className="text-xs text-muted">{r.part_family}</td>
                <td className="num font-medium">{r.donors}</td>
                <td className="num">{r.models}</td>
                <td className="num">{r.new_price_min ? Number(r.new_price_min).toFixed(2) : ""}</td>
                <td className="num" title={r.removal.source ?? "no removal time"}>{r.removal.minutes ?? <span className="text-wait">?</span>}</td>
                <td className="num">{r.sold_90 ?? ""}</td>
                <td className="num">{r.sell_through_pct ? Number(r.sell_through_pct).toFixed(1) : ""}</td>
                <td className="num">{r.active_qty ?? ""}</td>
                <td className="num">{r.avg_price ? Number(r.avg_price).toFixed(2) : ""}</td>
                <td className="num">{r.qualification?.economics ? usd(r.qualification.economics.breakEven) : ""}</td>
                <td>
                  {r.prefilter && r.market === "missing" ? <span className="pill pill-mute" title={r.prefilter}>skipped</span> : <QualificationPill v={r.qualification} market={r.market} />}
                  {r.market === "stale" ? <span className="pill pill-wait ml-1">stale</span> : null}
                </td>
                <td className="num">{r.qualification?.modeledValueSlotDay != null ? perSlotDay(r.qualification.modeledValueSlotDay) : ""}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={14} className="py-8 text-center text-muted">Nothing here yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <Pager total={total} limit={100} offset={offset} href={(o) => qs(base, { offset: o })} />

      <section className="card mt-6 p-4">
        <h2 className="mb-1 font-semibold">Import eBay market facts</h2>
        <p className="mb-3 text-xs text-muted">
          Accepts the shared research CSV (<span className="mono">{SHARED_RESEARCH_CSV_HEADERS.join(", ")}</span>), the same file EbayDecisions
          imports and exports. Parts Engine stores New Price and the 90-day columns; the 7- and 30-day columns are accepted and not stored.
          In it, 90 Day Sell Through % is read as typed: 45 is 45%, 0.45 is 0.45%. A row with no 90-day value gets no new research date.
        </p>
        <p className="mb-3 text-xs text-muted">
          Also accepts the older EbayDecisions export CSV, the decision workbook (MPN Master sheet), or a CSV with
          mpn, sold90, avg_price, avg_ship, sell_through_pct, active_qty, researched_at. In those, a sell-through like 0.24 is read as 24%.
          Sell-through is stored only when the file supplies exact-MPN sell-through; it is never calculated from sold and active counts.
        </p>
        <UploadForm action={importMarketAction} label="Import market facts" accept=".csv,.xlsx" />
      </section>

      <section className="card mt-5 p-4">
        <h2 className="mb-1 font-semibold">Import Roadrunner sales history</h2>
        <p className="mb-3 text-xs text-muted">
          What has actually sold for us, kept apart from market facts. CSV with <span className="mono">{SALES_HEADERS}</span>:
          one row per sale event (order line), item_price per unit before shipping, dates as YYYY-MM-DD. Re-importing the same
          source_event_id + MPN updates it instead of counting it twice. Buyer and other columns are never read.
        </p>
        <UploadForm action={importSalesAction} label="Import sales history" accept=".csv" />
      </section>
    </>
  );
}
