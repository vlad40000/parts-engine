import Link from "next/link";
import type { fleetSummary } from "@/src/db/queries";
import { DEFAULT_AGE_BANDS } from "@/src/lib/serial-decoder";
import { qs } from "@/src/components/ui";

type BandMatrix = Awaited<ReturnType<typeof fleetSummary>>["bandMatrix"];

/** Secondary reference data: hidden until the user explicitly expands it. */
export function FleetAgeBandPanel({ matrix }: { matrix: BandMatrix }) {
  return (
    <details className="card mt-5 p-4">
      <summary className="cursor-pointer font-semibold">
        Age band × type <span className="ml-2 text-xs font-normal text-muted">(expand)</span>
      </summary>
      <div className="mt-3 overflow-x-auto">
        <p className="mb-3 text-xs text-muted">
          A machine counts in every band one of its possible years falls in, so rows can add up to more than the machine count.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr><th>Type</th><th className="num">Machines</th>{DEFAULT_AGE_BANDS.map((b) => <th key={b.key} className="num">{b.label}</th>)}<th className="num">Unknown</th></tr>
          </thead>
          <tbody>
            {matrix.slice(0, 25).map((r) => (
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
      </div>
    </details>
  );
}
