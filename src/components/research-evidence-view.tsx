import type { EvidenceResolvedRow, EvidenceCounts } from "@/src/db/research-evidence";

const label=(s:string)=>s.replace(/_/g," ");
const value=(s:string|number|null|undefined)=>s==null ? "—" : String(s);

export function EvidenceCountsView({counts}:{counts:EvidenceCounts}){
  return <p className="my-3 text-sm font-medium">{counts.total} MPNs · {counts.researched} research entries · {counts.ownerSkip} Owner Skips · {counts.holds} comparability {counts.holds===1 ? "hold" : "holds"} · {counts.unreviewed} unreviewed</p>;
}

export function EvidenceRowsView({rows}:{rows:EvidenceResolvedRow[]}){
  return <div className="max-h-[36rem] overflow-auto rounded border border-line">
    <table className="w-full text-left text-xs">
      <caption className="p-3 text-left text-muted">Original summaries and audited subsets remain separate. Buyer shipping is not the carrier-label cost. All rows are retained as evidence.</caption>
      <thead><tr><th>Source row / MPN</th><th>Decision / identity</th><th>Raw sold</th><th>Raw item $</th><th>Raw buyer ship $</th><th>Raw sell-through</th><th>Comparability / audited subset</th><th>Dates / notes / conflicts</th></tr></thead>
      <tbody>{rows.map((r)=><tr key={r.inputMpnKey}>
        <td><span className="text-muted">{r.sourceRow}</span> <b className="mono">{r.mpnDisplay}</b><p className="max-w-64">{r.description}</p></td>
        <td><p>{label(r.decision)}</p><p className="text-muted">{label(r.resolution)}{r.resolvedMpnKey && r.resolvedMpnKey!==r.inputMpnKey ? `: ${r.resolvedMpnKey}` : ""}</p></td>
        <td className="num">{value(r.metrics.sold90)}</td>
        <td className="num">{value(r.metrics.avgItem)}</td>
        <td className="num break-all">{value(r.metrics.avgBuyerShipping)}</td>
        <td>{r.metrics.sellThrough ? <>{r.metrics.sellThrough.value} {r.metrics.sellThrough.unit}<p className="text-muted">{r.metrics.sellThrough.percent}%</p></> : "—"}</td>
        <td>{label(r.comparability)}<p>Audited sold: {value(r.audited.sold90)}</p><p>Item $: {value(r.audited.avgItem)}</p><p className="break-all">Buyer ship $: {value(r.audited.avgBuyerShipping)}</p>
          {r.audited.sellThrough ? <p>Audited sell-through: {r.audited.sellThrough.percent}%</p> : null}
        </td>
        <td><p>Observed: {r.observedOn??"unknown"}</p><p>Window: {r.windowStart??"unknown"} to {r.windowEnd??"unknown"}</p>
          {r.conflicts.length ? <p className="font-medium text-wait">Differs from active facts: {r.conflicts.join(", ")}. Active facts are unchanged.</p> : null}
          <details><summary className="cursor-pointer">Evidence details</summary>
            <p className="max-w-96 whitespace-pre-wrap">{r.notes||"No source notes."}</p>
            <p>Audited date: {r.auditedOn??"unknown"}</p><p>Audited window: {r.auditedWindowStart??"unknown"} to {r.auditedWindowEnd??"unknown"}</p>
            <p>Master incorporation date: {r.incorporatedOn??"unknown"}</p>
            {r.activeFacts ? <p>Active facts at preview: sold {value(r.activeFacts.sold90)}, item ${value(r.activeFacts.avgItem)}, shipping ${value(r.activeFacts.avgBuyerShipping)}, sell-through {value(r.activeFacts.sellThroughPercent)}%, researched {r.activeFacts.researchedOn??"unknown"}.</p> : null}
            <pre className="max-w-96 overflow-auto whitespace-pre-wrap">{JSON.stringify(r.raw,null,2)}</pre>
          </details>
        </td>
      </tr>)}</tbody>
    </table>
  </div>;
}
