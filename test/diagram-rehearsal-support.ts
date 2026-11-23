import { getModelDiagrams } from "@/src/db/model-diagrams";
import { saveDiagramBundle } from "@/src/db/model-diagram-bundle";
import { machineDetail, saveModelBom, upsertFleet } from "@/src/db/queries";
import type { Db } from "@/src/db/types";
import { mapFleetRows } from "@/src/lib/fleet-import";
import type { DiagramBundle } from "@/src/lib/model-diagram-bundle";
import { calloutRecordsFor, diagramReferencesByMpn, type CalloutRecord } from "@/src/lib/model-diagrams";
import { brandKey, modelKey } from "@/src/lib/model-key";
import { canonicalizeMpn } from "@/src/lib/mpn";
import { lookupModelBom, type ChainResult } from "@/src/sources/chain";
import { sectionKey } from "@/src/sources/diagrams/reconcile";
import { DIAGRAM_CASES, loadCase, machine6613Callout10, runDiagramCase, type CaseResult } from "./diagram-sources-support";

/**
 * One-model import rehearsal for Maytag MVW6230HW1, shared by the CI test (in-memory database) and the local on-disk
 * rehearsal that the real app serves. Fleet rows carry only identity (brand, model, type, status) for 6613 and 6601,
 * read from their public machine pages on 2026-11-23, plus synthetic neighbours (REH-…) with adjacent revisions.
 * The BOM comes from the real supplier chain replayed over the captured fixtures; nothing touches the network.
 */
export const MODEL = { brand: "Maytag", model: "MVW6230HW1" };
const TYPE = "Washer - Top Load / Agitator";

export const REHEARSAL_FLEET = [
  { ID: "6613", Brand: "Maytag", ModelNumber: "MVW6230HW1", Availability: "PARTS ONLY", ApplianceType: TYPE },
  { ID: "6601", Brand: "Maytag", ModelNumber: "MVW6230HW1", Availability: "BEING REPAIRED", ApplianceType: TYPE },
  { ID: "REH-HW0", Brand: "Maytag", ModelNumber: "MVW6230HW0", Availability: "PARTS ONLY", ApplianceType: TYPE },
  { ID: "REH-HW2", Brand: "Maytag", ModelNumber: "MVW6230HW2", Availability: "PARTS ONLY", ApplianceType: TYPE },
  { ID: "REH-HC1", Brand: "Maytag", ModelNumber: "MVW6230HC1", Availability: "PARTS ONLY", ApplianceType: TYPE },
  { ID: "REH-HW", Brand: "Maytag", ModelNumber: "MVW6230HW", Availability: "PARTS ONLY", ApplianceType: TYPE }
];
export const SHOWN = ["6613", "6601"];
export const ADJACENT = ["REH-HW0", "REH-HW2", "REH-HC1", "REH-HW"];

export async function maytagCase(): Promise<CaseResult> {
  const c = DIAGRAM_CASES.find((x) => x.id === "maytag-mvw6230hw1")!;
  const { manifest, fetcher, oem } = await loadCase(c);
  return runDiagramCase(c, fetcher, new Date(manifest.capturedAt), oem && {
    url: oem.url, status: oem.status, finalUrl: oem.finalUrl, sha256: oem.sha256, bytes: oem.bytes, extractor: oem.extractor, text: oem.text
  });
}

/** The four records for 6613's top-and-cabinet callout 10, filed under the section the page shows. */
export function callout10Records(maytag: CaseResult): CalloutRecord[] {
  const app = maytag.attempts.find((a) => a.provider === "appliancepartspros")!;
  const assembly = app.sections.find((s) => sectionKey(s.assembly) === "TOPANDCABINET")!.assembly;
  return machine6613Callout10(maytag).numbers.map((n) => ({
    assembly, callout: "10", partNumber: n.mpn, role: n.role, evidence: n.evidence, sourceUrl: n.source,
    machineNo: n.role === "observed" ? "6613" : null
  }));
}

export function maytagBundle(maytag: CaseResult): DiagramBundle {
  return {
    ...MODEL, variation: null,
    diagrams: maytag.attempts.find((a) => a.provider === "appliancepartspros")!,
    supporting: maytag.attempts.filter((a) => a.provider === "oem-parts-list"),
    calloutRecords: callout10Records(maytag)
  };
}

export async function seedRehearsal(db: Db) {
  await upsertFleet(db, mapFleetRows(REHEARSAL_FLEET).rows);
  const { fetcher } = await loadCase(DIAGRAM_CASES[0]);
  const bom = await lookupModelBom(MODEL, fetcher);
  await saveModelBom(db, { brandKey: brandKey(MODEL.brand), modelKey: modelKey(MODEL.model), brandDisplay: MODEL.brand, modelDisplay: MODEL.model, result: bom });
  // A neighbour whose own parts list shares the callout-10 board: the shared number must still show no diagram there.
  const shared = bom.winner!.rows.filter((r) => r.mpnCanonical === "W11543994");
  const neighbour: ChainResult = {
    status: "found", attempts: [],
    winner: { supplier: "rehearsal", status: "found", rows: shared, droppedRows: 0, sourceUrl: null, visited: [], warnings: [], elapsedMs: 0 }
  };
  await saveModelBom(db, { brandKey: "MAYTAG", modelKey: "MVW6230HW0", brandDisplay: "Maytag", modelDisplay: "MVW6230HW0", result: neighbour });
  const maytag = await maytagCase();
  const imported = await saveDiagramBundle(db, maytagBundle(maytag), "");
  return { bom, imported, maytag };
}

/** What each machine page would show, read through the page's own queries. */
export async function rehearsalView(db: Db, machineNo: string) {
  const d = await machineDetail(db, machineNo);
  if (!d) throw new Error(`machine ${machineNo} missing`);
  const entry = d.machine.identityStatus === "ok" ? await getModelDiagrams(db, d.machine) : undefined;
  const refs = diagramReferencesByMpn(entry?.evidence.sections ?? []);
  const board = d.parts.find((p) => canonicalizeMpn(p.bomMpnDisplay) === "W11543994");
  return {
    machineNo, model: d.machine.modelRaw, entry, bomRows: d.parts.length,
    boardReferences: board ? refs.get(canonicalizeMpn(board.bomMpnDisplay)) ?? [] : null,
    records: entry ? calloutRecordsFor(entry.evidence, machineNo) : []
  };
}
