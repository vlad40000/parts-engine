import { PUBLISHED_REPAIR_REFERENCES, REPAIR_REFERENCE_WARNING } from "@/src/lib/removal-references";

/** Optional published repair data, intentionally disconnected from operational cost formulas. */
export function RemovalReferenceView() {
  return (
    <details className="mt-5 border-t pt-4">
      <summary className="cursor-pointer text-sm font-semibold">Evidence &amp; advanced · published repair-time references (optional)</summary>
      <p className="my-3 text-sm font-semibold text-muted">{REPAIR_REFERENCE_WARNING}</p>
      <p className="mb-3 text-xs text-muted">
        Published repair durations are model- and access-path-specific, may include replacement and reassembly,
        and are not a measured part-harvest time. They cannot automatically fill missing baseline values.
      </p>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-sm">
          <thead><tr><th scope="col">Appliance / component</th><th scope="col">Applicability</th><th scope="col">Published repair time</th><th scope="col">Source</th></tr></thead>
          <tbody>
            {PUBLISHED_REPAIR_REFERENCES.map((r) => (
              <tr key={r.id}>
                <td>{r.appliance} — {r.component}</td>
                <td>{[r.brand,r.model].filter(Boolean).join(" ") || "General guide"}</td>
                <td>{r.repair_min_min === null ? "Procedure only; no time" : `${r.repair_min_min}–${r.repair_min_max} min (repair)`}</td>
                <td><a className="text-accent underline" href={r.source_url} target="_blank" rel="noopener noreferrer">{r.source_title}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
