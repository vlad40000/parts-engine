import Link from "next/link";
import { getDb, hasDatabase } from "@/src/db";
import { fleetFacets, fleetSummary, listFleet } from "@/src/db/queries";
import { DEFAULT_AGE_BANDS } from "@/src/lib/serial-decoder";
import { NoDatabase, PageTitle, Pager, Stat, Years, qs } from "@/src/components/ui";

export const dynamic = "force-dynamic";
type SP = Promise<Record<string, string | undefined>>;

export default async function FleetPage({ searchParams }: { searchParams: SP }) {
  if (!hasDatabase()) return <NoDatabase />;
  const sp = await searchParams;
  const db = await getDb();
  const offset = Number(sp.offset ?? 0) || 0;
  const filter = { band: sp.band, type: sp.type, brand: sp.brand, availability: sp.availability, q: sp.q };
  const [summary, facets, list] = await Promise.all([fleetSummary(db), fleetFacets(db), listFleet(db, filter, 100, offset)]);
  const base = { band: sp.band, type: sp.type, brand: sp.brand, availability: sp.availability, q: sp.q };

  if (!summary.totals?.machines) {
    return (
      <>
        <PageTitle title="Fleet" />
        <div className="card p-5 text-sm">No machines yet. <Link className="text-accent underline" href="/intake">Import the inventory workbook</Link> to start.</div>
      </>
    );
  }

  return (
    <>
      <PageTitle title="Fleet" sub="Every machine on the lot, banded by every build year its serial allows. Amber years mean the serial code repeats across cycles." />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Machines on the lot" value={summary.totals.machines.toLocaleString()} hint={`${summary.offLot.toLocaleString()} sold or scrapped not counted`} />
        <Stat label="Distinct models" value={summary.totals.models.toLocaleString()} />
        <Stat label="Models with parts list" value={summary.totals.models_with_bom.toLocaleString()} hint={`${summary.totals.with_bom.toLocaleString()} machines covered`} />
        <Stat label="MPNs indexed" value={summary.market?.mpns.toLocaleString() ?? 0} hint={`${summary.market?.researched ?? 0} with eBay data`} />
        <Stat label="Need nameplate" value={summary.totals.needs_nameplate.toLocaleString()} />
      </div>

      <section className="card mb-5 overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">Age band × type</h2>
        <p className="mb-3 text-xs text-muted">A machine counts in every band one of its possible years falls in, so rows can add up to more than the machine count.</p>
        <table className="w-full text-sm">
          <thead>
            <tr><th>Type</th><th className="num">Machines</th>{DEFAULT_AGE_BANDS.map((b) => <th key={b.key} className="num">{b.label}</th>)}<th className="num">Unknown</th></tr>
          </thead>
          <tbody>
            {summary.bandMatrix.slice(0, 25).map((r) => (
              <tr key={r.type}>
                <td><Link className="hover:underline" href={qs({}, { type: r.type })}>{r.type || "—"}</Link></td>
                <td className="num">{r.counts.total}</td>
                {DEFAULT_AGE_BANDS.map((b) => (
                  <td key={b.key} className="num">
                    {r.counts[b.key] ? <Link className="hover:underline" href={`/bom${qs({}, { type: r.type, band: b.key })}`}>{r.counts[b.key]}</Link> : <span className="text-muted">·</span>}
                  </td>
                ))}
                <td className="num text-muted">{r.counts.unknown || "·"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">Click a band count to open those models in Parts lists.</p>
      </section>

      <form className="mb-3 flex flex-wrap items-end gap-2 text-sm">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Machine #, model or serial" className="input w-56" />
        <select name="availability" defaultValue={sp.availability ?? ""} className="input">
          <option value="">Any status</option>
          {facets.availability.map((a) => <option key={a}>{a}</option>)}
        </select>
        <select name="type" defaultValue={sp.type ?? ""} className="input">
          <option value="">Any type</option>
          {facets.types.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select name="band" defaultValue={sp.band ?? ""} className="input">
          <option value="">Any age</option>
          {DEFAULT_AGE_BANDS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          <option value="unknown">Unknown age</option>
        </select>
        <button className="btn">Filter</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th>#</th><th>Status</th><th>Type</th><th>Brand</th><th>Model</th><th>Serial</th><th>Possible years</th><th>Symptom flags</th><th>Parts list</th></tr></thead>
          <tbody>
            {list.rows.map((m) => (
              <tr key={m.machine_no}>
                <td><Link className="mono text-accent hover:underline" href={`/machines/${encodeURIComponent(m.machine_no)}`}>{m.machine_no}</Link></td>
                <td className="text-xs">{m.availability}</td>
                <td className="text-xs">{m.appliance_type}</td>
                <td>{m.brand}</td>
                <td className="mono">{m.model_raw}{m.identity_status !== "ok" ? <span className="pill pill-wait ml-1">nameplate</span> : null}</td>
                <td className="mono text-xs">{m.serial}</td>
                <td className="text-xs"><Years years={m.age_candidate_years} /></td>
                <td className="text-xs text-muted">{m.suspect_families.join(", ")}</td>
                <td>{m.bom_status === "found" ? <span className="pill pill-go">yes</span> : m.bom_status ? <span className="pill pill-mute">{m.bom_status.replace("_", " ")}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager total={list.total} limit={100} offset={offset} href={(o) => qs(base, { offset: o })} />
    </>
  );
}
