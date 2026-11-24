import { importDiagramWorkbookAction, importMaytag6613DiagramAction } from "@/app/model-diagram-actions";
import { ButtonForm, UploadForm } from "@/src/components/forms";
import { MAYTAG_DIAGRAM_PILOT } from "@/src/lib/maytag-6613-diagram";
import { diagramImportEnabled } from "@/src/lib/model-diagram-access";
import { calloutRecordsFor, type CalloutRole, type DiagramReference, type ModelDiagrams } from "@/src/lib/model-diagrams";

const diagramLink = "text-accent underline";

const ROLE_LABEL: Record<CalloutRole, string> = {
  catalog: "Catalog", supplier_listed: "Supplier listed", replacement: "Service replacement", observed: "Observed on this machine"
};

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
  const allowImport = diagramImportEnabled();
  if (!entry && !allowImport) return null;
  const records = entry ? calloutRecordsFor(entry.evidence, machineNo) : [];
  return (
    <section className="card mb-5 p-3 text-sm" aria-label="Assembly diagrams">
      {entry && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Assembly diagrams</h2>
            <a href={entry.evidence.sourceUrl} target="_blank" rel="noreferrer" className={diagramLink}>{entry.evidence.sourceLabel ?? "Encompass source"}</a>
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
                {records.some((r) => r.assembly === assembly) && (
                  <table className="mt-1 w-full text-xs" aria-label={`Callout evidence for ${assembly}`}>
                    <thead><tr><th>Callout</th><th>Role</th><th>Part number</th><th>Evidence</th></tr></thead>
                    <tbody>
                      {records.filter((r) => r.assembly === assembly).map((r, index) => (
                        <tr key={index}>
                          <td className="mono">{r.callout}</td>
                          <td>{ROLE_LABEL[r.role]}</td>
                          <td className="mono">{r.partNumber}</td>
                          <td>{r.sourceUrl ? <a href={r.sourceUrl} target="_blank" rel="noreferrer" className={diagramLink}>{r.evidence}</a> : r.evidence}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
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
      {allowImport && (
        <details className={entry ? "mt-2" : ""}>
          <summary className="cursor-pointer font-medium">{entry ? "Replace diagram workbook" : "Add assembly diagrams"}</summary>
          <div className="mt-2">
            <p className="mb-2 text-xs text-muted">Choose the Encompass XLSX with Parts and Diagrams sheets. Machines with this same full model share the diagrams.</p>
            <UploadForm action={importDiagramWorkbookAction} label={entry ? "Replace workbook" : "Import diagram workbook"} accept=".xlsx">
              <input type="hidden" name="machineNo" value={machineNo} />
              <input type="hidden" name="expectedSha256" value={entry?.sourceSha256 ?? ""} />
              <label className="mb-2 flex w-fit flex-col gap-1 text-xs">
                Diagram import key
                <input type="password" name="importKey" className="input" autoComplete="off" maxLength={256} required />
              </label>
            </UploadForm>
          </div>
        </details>
      )}
      {allowImport && !entry && machineNo === MAYTAG_DIAGRAM_PILOT.machineNo && (
        <details className="mt-2">
          <summary className="cursor-pointer font-medium">Import reviewed Maytag diagrams</summary>
          <div className="mt-2">
            <ButtonForm action={importMaytag6613DiagramAction} label="Import reviewed bundle">
              <input type="hidden" name="machineNo" value={machineNo} />
              <label className="mb-2 flex w-fit flex-col gap-1 text-xs">
                Diagram import key
                <input type="password" name="importKey" className="input" autoComplete="off" maxLength={256} required />
              </label>
            </ButtonForm>
          </div>
        </details>
      )}
    </section>
  );
}
