import "server-only";
import { createHash } from "node:crypto";
import type { DiagramAttempt } from "@/src/sources/diagrams/types";
import { brandKey } from "./model-key";
import { canonicalizeMpn } from "./mpn";
import { exactDiagramModel, type CalloutRecord, type ModelDiagrams, type ModelDiagramSection } from "./model-diagrams";

/**
 * A reviewed acquisition bundle for one exact model (src/sources/diagrams), turned into the model_diagrams evidence
 * the machine page already reads. Rehearsal path: no action, route or page calls it, and the operator upload stays
 * the Encompass workbook. Only complete attempts for exactly this brand, model and variation are accepted.
 */
export class DiagramBundleError extends Error {}

const PROVIDER: Record<DiagramAttempt["provider"], string> = {
  appliancepartspros: "AppliancePartsPros", encompass: "Encompass", homedepot: "Home Depot Repair Parts", "oem-parts-list": "OEM parts list"
};

export type DiagramBundle = {
  brand: string;
  model: string;
  variation?: string | null;
  /** The attempt whose drawings and callouts machine pages show. */
  diagrams: DiagramAttempt;
  /** Other reviewed evidence for the model, such as the maker's parts list; named in the source note. */
  supporting?: DiagramAttempt[];
  calloutRecords?: CalloutRecord[];
};

const name = (brand: string, model: string, variation?: string | null) => `${brand} ${model}${variation ? ` (${variation})` : ""}`;

function checkAttempt(b: DiagramBundle, a: DiagramAttempt, what: string) {
  if (a.outcome !== "complete") throw new DiagramBundleError(`${what} is ${a.outcome}, not complete: ${a.reason}`);
  if (brandKey(a.brand) !== brandKey(b.brand) || exactDiagramModel(a.model) !== exactDiagramModel(b.model)
    || (a.variation ?? null) !== (b.variation ?? null)) {
    throw new DiagramBundleError(`${what} is for ${name(a.brand, a.model, a.variation)}, not ${name(b.brand, b.model, b.variation)}.`);
  }
  if (!a.sourceUrl?.startsWith("https://")) throw new DiagramBundleError(`${what} has no confirmed https source.`);
}

export function diagramBundleEvidence(b: DiagramBundle): ModelDiagrams & { sourceSha256: string } {
  const provider = PROVIDER[b.diagrams.provider];
  checkAttempt(b, b.diagrams, `The ${provider} diagrams`);
  for (const a of b.supporting ?? []) checkAttempt(b, a, `The ${PROVIDER[a.provider]} evidence`);

  const sections: ModelDiagramSection[] = b.diagrams.sections.map((s) => {
    if (!s.diagramUrl?.startsWith("https://")) throw new DiagramBundleError(`${s.assembly} has no https drawing.`);
    const unread = s.unreadRows.map((r) => r.callout).filter(Boolean);
    return {
      assembly: s.assembly, imageUrl: s.diagramUrl,
      note: unread.length ? `Listed without a readable part number at callout ${unread.join(", ")}.` : "",
      parts: s.callouts.map((c) => ({ callout: c.callout, partNumber: c.supplierMpn, description: c.description }))
    };
  });
  const assemblies = new Set(sections.map((s) => s.assembly));
  const records = b.calloutRecords ?? [];
  for (const r of records) {
    if (!assemblies.has(r.assembly) || !r.callout.trim() || !canonicalizeMpn(r.partNumber) || !r.evidence.trim()) {
      throw new DiagramBundleError(`Callout record ${r.role} ${r.partNumber} at ${r.assembly} #${r.callout} needs a shown section, a callout, a part number and its evidence.`);
    }
    if (r.role === "observed" && !r.machineNo) throw new DiagramBundleError(`Observed part ${r.partNumber} must name the machine it was read on.`);
  }
  const rows = sections.reduce((n, s) => n + s.parts.length, 0);
  const sourceNote = [
    `${provider}, retrieved ${b.diagrams.retrievedAt}: ${sections.length} assemblies, ${rows} callout rows. Part numbers are as ${provider} lists them, usually the current service part.`,
    ...(b.supporting ?? []).map((a) => `${PROVIDER[a.provider]}: ${a.sourceUrl} (${a.identity}).`)
  ].join(" ");
  const evidence: ModelDiagrams = { sourceUrl: b.diagrams.sourceUrl!, sourceLabel: `${provider} source`, sourceNote, sections, calloutRecords: records };
  return { ...evidence, sourceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
}
