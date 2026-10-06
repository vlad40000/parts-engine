"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/src/db";
import {
  addAlias, getSettings, saveSettings, setPartState, updateMpnManual, upsertBaseline, upsertFleet, upsertMarketFacts, upsertSaleEvents
} from "@/src/db/queries";
import { parseCsvRecords } from "@/src/lib/csv";
import { mapFleetRows, readFleetFile } from "@/src/lib/fleet-import";
import { mapMarketRows } from "@/src/lib/market-import";
import { ensureMachineBom } from "@/src/lib/model-bom";
import { canonicalizeMpn } from "@/src/lib/mpn";
import { mapSaleRows, SALES_HEADERS } from "@/src/lib/sales-import";
import { readTable } from "@/src/lib/table-read";

export type ActionResult = { ok: boolean; message: string; details?: string[] };

export async function importFleetAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose an .xlsx or .csv file." };
  try {
    const records = await readFleetFile(file.name, await file.arrayBuffer());
    const res = mapFleetRows(records);
    if (!res.rows.length) return { ok: false, message: "No machine rows found. The sheet needs ID/No., Brand and Model columns." };
    await upsertFleet(await getDb(), res.rows);
    revalidatePath("/", "layout");
    const ambiguous = res.rows.filter((r) => r.ageConfidence === "ambiguous").length;
    const nameplate = res.rows.filter((r) => r.identityStatus === "needs_nameplate").length;
    return {
      ok: true,
      message: `Imported ${res.rows.length.toLocaleString()} machines from ${file.name}.`,
      details: [
        `${ambiguous.toLocaleString()} have more than one possible build year (kept, not collapsed).`,
        `${nameplate.toLocaleString()} need a nameplate read before parts lookup.`,
        res.duplicates.length ? `${res.duplicates.length} duplicate IDs skipped (first row kept): ${res.duplicates.slice(0, 10).join(", ")}` : "",
        res.skipped.length ? `${res.skipped.length} rows skipped: ${res.skipped.slice(0, 5).map((s) => `line ${s.line} ${s.reason}`).join("; ")}` : "",
        res.ignoredColumns.length ? `Columns not imported: ${res.ignoredColumns.join(", ")}` : ""
      ].filter(Boolean)
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Import failed." };
  }
}

export async function addMachineAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const rec = {
    ID: String(form.get("machineNo") ?? "").trim(),
    Availability: String(form.get("availability") ?? "UNCHECKED"),
    ApplianceType: String(form.get("applianceType") ?? ""),
    Brand: String(form.get("brand") ?? ""),
    ModelNumber: String(form.get("model") ?? ""),
    SerialNumber: String(form.get("serial") ?? ""),
    Condition: String(form.get("condition") ?? ""),
    Diagnosis: String(form.get("diagnosis") ?? "")
  };
  if (!rec.ID) return { ok: false, message: "Machine ID is required." };
  const res = mapFleetRows([rec]);
  const db = await getDb();
  await upsertFleet(db, res.rows);
  const m = res.rows[0];
  // Single-machine adds only: reuse the cached model BOM, or read it once. Bulk import never does this.
  // A failed lookup never undoes the save; machine detail shows the BOM status.
  try {
    await ensureMachineBom(db, m);
  } catch (error) {
    console.error(`Parts list lookup failed for machine ${m.machineNo}:`, error instanceof Error ? error.message : error);
  }
  revalidatePath("/", "layout");
  redirect(`/machines/${encodeURIComponent(m.machineNo)}`);
}

const isMarketHeader = (cells: string[]) => cells.some((c) => /^(mpn|part ?number|sku)$/i.test(c.trim()));

export async function importMarketAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a CSV or .xlsx file." };
  try {
    const records = await readTable(file.name, await file.arrayBuffer(), isMarketHeader, "MPN Master");
    const { rows, skipped } = mapMarketRows(records);
    if (!rows.length) return { ok: false, message: skipped[0] ?? "No market rows found." };
    const res = await upsertMarketFacts(await getDb(), rows, `import:${file.name}`);
    revalidatePath("/", "layout");
    const derived = rows.filter((r) => r.sellThroughDerived).length;
    return {
      ok: true,
      message: `Saved market facts for ${res.saved} MPNs.`,
      details: [
        res.unknown ? `${res.unknown} are not in any parts list yet (added to the MPN index with no donors).` : "",
        derived ? `${derived} had no sell-through column; derived as sold ÷ (sold + active).` : "",
        skipped.length ? `${skipped.length} skipped: ${skipped.slice(0, 5).join(" ")}` : ""
      ].filter(Boolean)
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Import failed." };
  }
}

export async function importSalesAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a .csv file." };
  if (!/\.csv$/i.test(file.name)) return { ok: false, message: "Sales history import takes the .csv contract only." };
  try {
    const records = parseCsvRecords(new TextDecoder().decode(await file.arrayBuffer()));
    const res = mapSaleRows(records);
    if (res.missingColumns.length) {
      return { ok: false, message: `Missing required columns: ${res.missingColumns.join(", ")}.`, details: [`Expected: ${SALES_HEADERS}`] };
    }
    const skippedLine = res.skipped.length
      ? `${res.skipped.length} rows skipped: ${res.skipped.slice(0, 5).map((s) => `line ${s.line} ${s.reason}`).join("; ")}`
      : "";
    if (!res.rows.length) return { ok: false, message: "No sale rows saved.", details: [`Saved 0, skipped ${res.skipped.length}.`, skippedLine].filter(Boolean) };
    // The filename is user-controlled and may carry PII, so it is never passed on or stored.
    const saved = await upsertSaleEvents(await getDb(), res.rows);
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `Saved ${res.rows.length} sale rows (${saved.inserted} new, ${saved.updated} already recorded and refreshed), skipped ${res.skipped.length}.`,
      details: [
        skippedLine,
        saved.notInAnyPartsList ? `${saved.notInAnyPartsList} MPNs are not in any parts list yet. Their history is kept and appears when a parts list includes them.` : "",
        res.ignoredColumns.length ? `Columns not imported: ${res.ignoredColumns.join(", ")}` : ""
      ].filter(Boolean)
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Import failed." };
  }
}

const num = (v: FormDataEntryValue | null) => {
  const t = String(v ?? "").replace(/[$,%\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export async function saveMarketAction(form: FormData): Promise<void> {
  const mpn = String(form.get("mpn") ?? "");
  const sellThrough = num(form.get("sellThroughPct"));
  await upsertMarketFacts(await getDb(), [{
    mpnCanonical: canonicalizeMpn(mpn),
    mpnDisplay: mpn,
    description: null,
    sold90: num(form.get("sold90")),
    avgPrice: num(form.get("avgPrice")),
    avgShip: num(form.get("avgShip")),
    sellThroughPct: sellThrough,
    sellThroughDerived: false,
    activeQty: num(form.get("activeQty")),
    qtyOnHand: num(form.get("qtyOnHand")),
    researchedAt: String(form.get("researchedAt") ?? "") || null,
    freeShipping: form.get("freeShipping") === "on",
    shipCost: num(form.get("shipCost"))
  }], "manual");
  revalidatePath("/", "layout");
}

export async function saveMpnManualAction(form: FormData): Promise<void> {
  const mpn = canonicalizeMpn(String(form.get("mpn") ?? ""));
  const removal = String(form.get("removalMin") ?? "").trim();
  await updateMpnManual(await getDb(), mpn, {
    removalMin: removal === "" ? null : Number(removal),
    forceResearch: form.get("forceResearch") === "on"
  });
  revalidatePath("/", "layout");
}

export async function addAliasAction(form: FormData): Promise<void> {
  const kind = String(form.get("kind") ?? "supersedes") as "supersedes" | "wp_prefix" | "variant";
  await addAlias(await getDb(), String(form.get("alias") ?? ""), String(form.get("target") ?? ""), kind);
  revalidatePath("/", "layout");
}

export async function setPartStateAction(form: FormData): Promise<void> {
  const state = String(form.get("state") ?? "");
  await setPartState(
    await getDb(),
    String(form.get("machineNo")),
    String(form.get("mpn")),
    state === "clear" ? null : (state as "pulled" | "failed" | "missing" | "skip")
  );
  revalidatePath("/", "layout");
}

export async function saveSettingsAction(form: FormData): Promise<void> {
  const db = await getDb();
  const s = await getSettings(db);
  const n = (k: string, fallback: number) => num(form.get(k)) ?? fallback;
  await saveSettings(db, {
    ...s,
    feePct: n("feePct", s.feePct),
    minSellThroughPct: n("minSellThroughPct", s.minSellThroughPct),
    harvestCushion: n("harvestCushion", s.harvestCushion),
    minProfit: n("minProfit", s.minProfit),
    laborRateHr: n("laborRateHr", s.laborRateHr),
    defaultShipCost: n("defaultShipCost", s.defaultShipCost),
    machineOverhead: n("machineOverhead", s.machineOverhead),
    stockWindowDays: Math.round(n("stockWindowDays", s.stockWindowDays)),
    batchSize: Math.min(50, Math.max(1, Math.round(n("batchSize", s.batchSize)))),
    marketStaleDays: Math.round(n("marketStaleDays", s.marketStaleDays)),
    donorAvailabilities: String(form.get("donorAvailabilities") ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)
  });
  revalidatePath("/", "layout");
}

export async function saveBaselineAction(form: FormData): Promise<void> {
  const minutes = num(form.get("minutes"));
  const appliance = String(form.get("appliance") ?? "").trim();
  const component = String(form.get("component") ?? "").trim();
  if (minutes == null || !appliance || !component) return;
  await upsertBaseline(await getDb(), { appliance, component, minutes });
  revalidatePath("/", "layout");
}
