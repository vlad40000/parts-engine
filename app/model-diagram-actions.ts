"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/src/db";
import { saveDiagramBundle } from "@/src/db/model-diagram-bundle";
import { isDiagramTableMissing, saveModelDiagrams } from "@/src/db/model-diagrams";
import { fleetMachines } from "@/src/db/schema";
import { MAYTAG_DIAGRAM_PILOT, reviewedMaytagDiagramBundle } from "@/src/lib/maytag-6613-diagram";
import { canImportDiagrams } from "@/src/lib/model-diagram-access";
import { DiagramBundleError } from "@/src/lib/model-diagram-bundle";
import { exactDiagramModel } from "@/src/lib/model-diagrams";
import { DiagramWorkbookError, readModelDiagramWorkbook } from "@/src/lib/model-diagram-workbook";
import { brandKey } from "@/src/lib/model-key";
import type { ActionResult } from "./actions";

export async function importDiagramWorkbookAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  if (!canImportDiagrams(form.get("importKey"))) return { ok: false, message: "Diagram import requires an authorized import key." };
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, message: "Choose the XLSX diagram workbook." };
  const machineNo = String(form.get("machineNo") ?? "").trim();
  const expectedSha256 = String(form.get("expectedSha256") ?? "");
  try {
    const db = await getDb();
    const [machine] = await db.select({ brand: fleetMachines.brand, modelRaw: fleetMachines.modelRaw, identityStatus: fleetMachines.identityStatus })
      .from(fleetMachines).where(eq(fleetMachines.machineNo, machineNo));
    if (!machine || machine.identityStatus !== "ok") {
      return { ok: false, message: "Verify the machine's full model number before importing diagrams." };
    }
    const workbook = await readModelDiagramWorkbook(file, machine.brand, machine.modelRaw);
    if (!await saveModelDiagrams(db, machine, workbook, expectedSha256)) {
      return { ok: false, message: "Another workbook was saved for this model. Reload the machine page and review it before replacing it." };
    }
    revalidatePath("/machines/[id]", "page");
    const callouts = workbook.sections.reduce((count, section) => count + section.parts.length, 0);
    return { ok: true, message: `Saved ${workbook.sections.length} assembly diagrams and ${callouts} callout rows for ${machine.brand} ${machine.modelRaw}.` };
  } catch (error) {
    const message = error instanceof DiagramWorkbookError ? error.message
      : isDiagramTableMissing(error) ? "Diagram imports require the pending database update."
      : "Could not save the diagram workbook. Try again.";
    return { ok: false, message };
  }
}

export async function importMaytag6613DiagramAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  if (!canImportDiagrams(form.get("importKey"))) return { ok: false, message: "Diagram import requires an authorized import key." };
  const pilot = MAYTAG_DIAGRAM_PILOT;
  if (form.get("machineNo") !== pilot.machineNo) return { ok: false, message: "The reviewed bundle is for machine 6613." };

  try {
    const db = await getDb();
    const [machine] = await db.select({
      brand: fleetMachines.brand,
      modelRaw: fleetMachines.modelRaw,
      serial: fleetMachines.serial,
      identityStatus: fleetMachines.identityStatus
    }).from(fleetMachines).where(eq(fleetMachines.machineNo, pilot.machineNo));
    if (!machine || machine.identityStatus !== "ok" || brandKey(machine.brand) !== brandKey(pilot.brand)
      || exactDiagramModel(machine.modelRaw) !== pilot.model || machine.serial?.trim().toUpperCase() !== pilot.serial) {
      return { ok: false, message: "Verify the reviewed model and serial on machine 6613 before importing." };
    }

    const bundle = await reviewedMaytagDiagramBundle();
    // An empty expected hash permits the first insert or an identical retry.
    const result = await saveDiagramBundle(db, bundle, "");
    if (!result.saved) return { ok: false, message: "Different diagram evidence is already saved for this model." };
    revalidatePath("/machines/[id]", "page");
    revalidatePath("/diagram-coverage");
    return { ok: true, message: `Saved the reviewed diagrams for ${pilot.brand} ${pilot.model}.` };
  } catch (error) {
    const message = error instanceof DiagramBundleError ? error.message
      : isDiagramTableMissing(error) ? "Diagram imports require the pending database update."
      : "Could not save the reviewed Maytag diagrams. Try again.";
    return { ok: false, message };
  }
}
