import { inArray } from "drizzle-orm";
import { DiagramBundleError, diagramBundleEvidence, type DiagramBundle } from "@/src/lib/model-diagram-bundle";
import { brandKey } from "@/src/lib/model-key";
import { exactDiagramModel } from "@/src/lib/model-diagrams";
import { saveModelDiagrams } from "./model-diagrams";
import { fleetMachines } from "./schema";
import type { Db } from "./types";

/**
 * Save a reviewed bundle as the exact model's diagrams, with the same exact key and stale-version check as a workbook
 * import. A record about one machine is accepted only for a fleet machine of exactly this brand and model.
 */
export async function saveDiagramBundle(db: Db, bundle: DiagramBundle, expectedSha256: string) {
  const evidence = diagramBundleEvidence(bundle);
  const machineNos = [...new Set((bundle.calloutRecords ?? []).flatMap((r) => (r.machineNo ? [r.machineNo] : [])))];
  if (machineNos.length) {
    const machines = await db.select({ machineNo: fleetMachines.machineNo, brand: fleetMachines.brand, modelRaw: fleetMachines.modelRaw })
      .from(fleetMachines).where(inArray(fleetMachines.machineNo, machineNos));
    for (const machineNo of machineNos) {
      const m = machines.find((x) => x.machineNo === machineNo);
      if (!m || brandKey(m.brand) !== brandKey(bundle.brand) || exactDiagramModel(m.modelRaw) !== exactDiagramModel(bundle.model)) {
        throw new DiagramBundleError(`Machine ${machineNo} is not a ${bundle.brand} ${bundle.model} in the fleet, so its observed part cannot be attached.`);
      }
    }
  }
  const saved = await saveModelDiagrams(db, { brand: bundle.brand, modelRaw: bundle.model }, evidence, expectedSha256);
  return { saved, sourceSha256: evidence.sourceSha256 };
}
