import "server-only";
import { DiagramBundleError, type DiagramBundle } from "./model-diagram-bundle";
import type { CalloutRole } from "./model-diagrams";
import type { DiagramAttempt } from "@/src/sources/diagrams/types";
import { sectionKey } from "@/src/sources/diagrams/reconcile";

export const MAYTAG_DIAGRAM_PILOT = {
  machineNo: "6613",
  brand: "Maytag",
  model: "MVW6230HW1",
  serial: "CA1304279"
} as const;

/** Use the reviewed acquisition snapshot rather than fetching supplier pages during the import. */
export async function reviewedMaytagDiagramBundle(): Promise<DiagramBundle> {
  const { cases, machine6613 } = (await import("@/test/fixtures/diagrams/results.json")).default;
  const attempts = cases.find((item) => item.case.id === "maytag-mvw6230hw1")?.attempts ?? [];
  const diagrams = attempts.find((attempt) => attempt.provider === "appliancepartspros") as DiagramAttempt | undefined;
  const catalog = attempts.find((attempt) => attempt.provider === "oem-parts-list") as DiagramAttempt | undefined;
  const assembly = diagrams?.sections.find((section) => sectionKey(section.assembly) === sectionKey(machine6613.section));
  if (!diagrams || !catalog || !assembly) {
    throw new DiagramBundleError("The reviewed Maytag diagram or catalog evidence is missing.");
  }
  return {
    brand: MAYTAG_DIAGRAM_PILOT.brand,
    model: MAYTAG_DIAGRAM_PILOT.model,
    variation: null,
    diagrams,
    supporting: [catalog],
    calloutRecords: machine6613.numbers.map((number) => ({
      assembly: assembly.assembly,
      callout: machine6613.callout,
      partNumber: number.mpn,
      role: number.role as CalloutRole,
      evidence: number.evidence,
      sourceUrl: number.source,
      machineNo: number.role === "observed" ? MAYTAG_DIAGRAM_PILOT.machineNo : null
    }))
  };
}
