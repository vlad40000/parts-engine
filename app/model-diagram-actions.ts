"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/src/db";
import { isDiagramTableMissing, saveModelDiagrams } from "@/src/db/model-diagrams";
import { fleetMachines } from "@/src/db/schema";
import { DiagramWorkbookError, readModelDiagramWorkbook } from "@/src/lib/model-diagram-workbook";
import type { ActionResult } from "./actions";

export async function importDiagramWorkbookAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  if (process.env.VERCEL_ENV === "preview") return { ok: false, message: "Diagram imports are disabled in deployment previews." };
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
