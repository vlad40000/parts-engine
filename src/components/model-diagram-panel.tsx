import { importDiagramWorkbookAction } from "@/app/model-diagram-actions";
import { UploadForm } from "@/src/components/forms";
import type { DiagramReference, ModelDiagrams } from "@/src/lib/model-diagrams";

const diagramLink = "text-accent underline";

export function PartDiagramReferences({ references, fallback }: { references?: DiagramReference[]; fallback: string }) {
  if (!references?.length) return fallback;
  return references.map(({ assembly, callout, imageUrl }, index) => (
    <div key={index}>
      <a href={imageUrl} target="_blank" rel="noreferrer" className={diagramLink}>{assembly} · #{callout}</a>
    </div>
  ));
}

export function ModelDiagramPanel({ machineNo, entry }: {
  machineNo: string;
  entry: { sourceSha256: string; evidence: ModelDiagrams } | null;
}) {
  return (
    <section className="card mb-5 p-3 text-sm" aria-label="Assembly diagrams">
      {entry && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Assembly diagrams</h2>
            <a href={entry.evidence.sourceUrl} target="_blank" rel="noreferrer" className={diagramLink}>Encompass source</a>
          </div>
          {entry.evidence.sourceNote && <p className="text-xs text-muted">{entry.evidence.sourceNote}</p>}
          <ul className="mt-2 divide-y divide-line">
            {entry.evidence.sections.map(({ assembly, imageUrl, note, parts }) => (
              <li key={assembly} className="py-2">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h3 className="font-medium">{assembly}</h3>
                  <a href={imageUrl} target="_blank" rel="noreferrer" className={diagramLink} aria-label={`Open diagram for ${assembly}`}>Open diagram</a>
                </div>
                {note && <p className="text-xs text-muted">{note}</p>}
                {parts.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs">{parts.length} callouts</summary>
                    <div className="mt-1 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead><tr><th>Callout</th><th>Part number</th><th>Description</th></tr></thead>
                        <tbody>
                          {parts.map(({ callout, partNumber, description }, index) => (
                            <tr key={index}><td className="mono">{callout}</td><td className="mono">{partNumber}</td><td>{description}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <details className={entry ? "mt-2" : ""}>
        <summary className="cursor-pointer font-medium">{entry ? "Replace diagram workbook" : "Add assembly diagrams"}</summary>
        <div className="mt-2">
          <p className="mb-2 text-xs text-muted">Choose the Encompass XLSX with Parts and Diagrams sheets. Machines with this same full model share the diagrams.</p>
          <UploadForm action={importDiagramWorkbookAction} label={entry ? "Replace workbook" : "Import diagram workbook"} accept=".xlsx">
            <input type="hidden" name="machineNo" value={machineNo} />
            <input type="hidden" name="expectedSha256" value={entry?.sourceSha256 ?? ""} />
          </UploadForm>
        </div>
      </details>
    </section>
  );
}
