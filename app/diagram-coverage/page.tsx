import Link from "next/link";
import { getDb, hasDatabase } from "@/src/db";
import { diagramCoverage, DIAGRAM_COVERAGE_PAGE_SIZE } from "@/src/db/diagram-coverage";
import { NoDatabase, PageTitle, Pager, qs } from "@/src/components/ui";

export const dynamic = "force-dynamic";

export default async function DiagramCoveragePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!hasDatabase()) return <NoDatabase />;
  const sp = await searchParams;
  const status = sp.status || undefined;
  const queue = await diagramCoverage(await getDb(), status, Number(sp.offset ?? 0));
  return <>
    <PageTitle title="Diagram coverage" sub="All fleet statuses are included. Saved supplier links are discovery leads and do not verify a diagram or manufacturer variation." />
    <form className="mb-4 flex items-end gap-2 text-sm">
      <label className="flex flex-col gap-1">Machine status
        <select name="status" defaultValue={status ?? ""} className="input"><option value="">All statuses</option>
          {queue.statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      </label><button className="btn">Filter</button>
    </form>
    <section className="card mb-4 p-4 text-sm">
      <p>{queue.totalMachines.toLocaleString()} machines · {queue.totalGroups.toLocaleString()} readable model groups · {queue.coverageAvailable ? <>{queue.coveredGroups?.toLocaleString()} groups with usable diagram and callout evidence ({queue.coveredMachines?.toLocaleString()} machines) · {queue.savedGroups?.toLocaleString()} groups with saved diagrams</> : "Diagram coverage unavailable"} · {queue.nameplates.length.toLocaleString()} need nameplate review</p>
      <p className="mt-2 text-muted">Groups use the brand and full model exactly as recorded, ignoring case and surrounding spaces. One usable assembly does not establish completeness. A separate manufacturer variation is not recorded in the current schema; variation verification remains unresolved even when a diagram is saved. Check the nameplate and source before reuse.</p>
      <Pager total={queue.totalGroups} limit={DIAGRAM_COVERAGE_PAGE_SIZE} offset={queue.offset} href={(offset) => qs({ status }, { offset })} />
    </section>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Brand / full model</th><th>Machines by status</th><th>Diagram evidence</th><th>Supplier lead</th><th>Example machine</th></tr></thead>
      <tbody>{queue.rows.map((row) => <tr className="border-t border-line" key={JSON.stringify([row.brand, row.model])}>
        <td className="p-2">{row.brand} {row.model}</td><td className="p-2">{row.machines.length} · {Object.entries(row.statuses).map(([s, n]) => `${s}: ${n}`).join(", ")}</td>
        <td className="p-2">{{ usable: "Usable diagram and callout evidence", diagram_only: "Saved diagram-only evidence", needs_review: "Saved record needs review", awaiting: "Awaiting diagrams", unavailable: "Diagram coverage unavailable" }[row.coverage]}<br /><span className="text-muted">Variation unverified</span></td>
        <td className="p-2">{row.lead ? <><a className="underline" href={row.lead.url} rel="noreferrer">{row.lead.exactRequest ? "Supplier discovery lead" : "Possible supplier lead · exact model/revision unverified"}</a>{row.lead.source ? ` (${row.lead.source})` : ""}</> : "—"}</td>
        <td className="p-2"><Link className="underline" href={`/machines/${encodeURIComponent(row.machines[0])}`}>{row.machines[0]}</Link></td>
      </tr>)}</tbody></table></div>
    <section className="card mt-5 p-4 text-sm"><h2 className="font-semibold">Needs nameplate ({queue.nameplates.length})</h2>
      {queue.nameplates.length ? <ul className="mt-2">{queue.nameplates.map((m) => <li key={m.machineNo}><Link className="underline" href={`/machines/${encodeURIComponent(m.machineNo)}`}>{m.machineNo}</Link> · {m.status} · {m.brand || "Missing brand"} · {m.model || "Missing model"}</li>)}</ul> : <p className="text-muted">None in this selection.</p>}
    </section>
  </>;
}
