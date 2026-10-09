"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/src/db";
import {
  addAlias, getMarketFacts, getSettings, patchProviderMarketFacts, saveSettings, saveSharedResearch, setPartState, updateMpnManual, upsertBaseline,
  upsertFleet, upsertMarketFacts, upsertSaleEvents
} from "@/src/db/queries";
import { parseCsvRecords, parseCsvRows } from "@/src/lib/csv";
import { mapFleetRows, readFleetFile } from "@/src/lib/fleet-import";
import { legacyResearchHeaders, mapMarketRows, MARKET_IMPORT_SOURCE } from "@/src/lib/market-import";
import { ensureMachineBom } from "@/src/lib/model-bom";
import {
  batchKeys, EBAYDECISIONS_MAX_MPNS, EBAYDECISIONS_SOURCE, EbayDecisionsError, ebayDecisionsConfig, fetchMarketFacts, planMarketFacts
} from "@/src/lib/ebaydecisions";
import { canonicalizeMpn } from "@/src/lib/mpn";
import { mapSaleRows, SALES_HEADERS } from "@/src/lib/sales-import";
import { parseSharedResearchTable, SHARED_RESEARCH_SOURCE, sharedResearchHeaders } from "@/src/lib/shared-research-csv";
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
    const buffer = await file.arrayBuffer();
    if (/\.csv$/i.test(file.name)) {
      const table = parseCsvRows(new TextDecoder().decode(buffer));
      if (sharedResearchHeaders(table[0] ?? []).length) return await importSharedResearch(table);
    }
    const records = await readTable(file.name, buffer, isMarketHeader, "MPN Master");
    const { rows, skipped } = mapMarketRows(records);
    if (!rows.length) {
      // A workbook cell formatted as a percent holds 0.45 for 45%, which the shared file's
      // as-typed 90 Day Sell Through % cannot tell apart, so the shared format is CSV only.
      if (sharedResearchHeaders(Object.keys(records[0] ?? {})).length) {
        return { ok: false, message: "The shared research file imports as .csv only. Save it as CSV and upload that; nothing was imported." };
      }
      return { ok: false, message: skipped[0] ?? "No market rows found." };
    }
    // The filename is user-controlled and may carry PII, so it is never passed on or stored.
    const res = await upsertMarketFacts(await getDb(), rows, MARKET_IMPORT_SOURCE);
    revalidatePath("/", "layout");
    const noSellThrough = rows.filter((r) => r.sellThroughPct == null).length;
    return {
      ok: true,
      message: `Saved market facts for ${res.saved} MPNs.`,
      details: [
        res.unknown ? `${res.unknown} are not in any parts list yet (added to the MPN index with no donors).` : "",
        noSellThrough ? `${noSellThrough} have no exact-MPN sell-through in the file; left blank (needs research).` : "",
        skipped.length ? `${skipped.length} skipped: ${skipped.slice(0, 5).join(" ")}` : ""
      ].filter(Boolean)
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Import failed." };
  }
}

const MAX_ERROR_DETAILS = 10;

/**
 * The shared research CSV, the same file EbayDecisions imports and exports. The whole file is
 * validated before anything is saved; only New Price and the 90-day window are stored.
 */
async function importSharedResearch(table: string[][]): Promise<ActionResult> {
  const legacy = legacyResearchHeaders(table[0]);
  if (legacy.length) {
    return { ok: false, message: `This file mixes shared research columns with older market columns (${legacy.join(", ")}). Use one format per file; nothing was imported.` };
  }
  const parsed = parseSharedResearchTable(table);
  if (!parsed.ok) {
    const more = parsed.errors.length - MAX_ERROR_DETAILS;
    return { ok: false, message: parsed.error, details: [...parsed.errors.slice(0, MAX_ERROR_DETAILS), more > 0 ? `…and ${more} more.` : ""].filter(Boolean) };
  }
  const researchedOn = new Date().toISOString().slice(0, 10);
  // The filename is user-controlled and may carry PII, so it is never passed on or stored.
  const res = await saveSharedResearch(await getDb(), parsed.rows, { researchedOn, source: SHARED_RESEARCH_SOURCE });
  revalidatePath("/", "layout");
  const researched = parsed.rows.filter((r) => r.research90 != null);
  const noSellThrough = researched.filter((r) => r.research90?.sellThroughPct == null).length;
  const undated = researched.filter((r) => r.researchedAt == null).length;
  return {
    ok: true,
    message: `Imported the shared research CSV: 90-day research saved for ${res.research} MPN${res.research === 1 ? "" : "s"}, New Price changed for ${res.newPrices}.`,
    details: [
      res.untouched ? `No 90-day research and no New Price, left as they were (no new research date): ${res.untouched}.` : "",
      noSellThrough ? `Saved without 90 Day Sell Through % (left blank, needs research; never calculated): ${noSellThrough}.` : "",
      undated ? `Researched rows with no research date, dated ${researchedOn} (the import date): ${undated}.` : "",
      res.unknown ? `Not in any parts list yet (added to the MPN index with no donors): ${res.unknown}.` : "",
      parsed.notStored.length ? `Accepted, not stored in Parts Engine: ${parsed.notStored.join(", ")}.` : "",
      parsed.ignored.length ? `Columns not imported: ${parsed.ignored.join(", ")}.` : ""
    ].filter(Boolean)
  };
}

/**
 * Explicit, user-triggered refresh of the MPNs on the rendered page from EbayDecisions:
 * one batch request, no polling, no research triggered. The response is fully validated
 * before anything is written; on any failure nothing is saved.
 */
export async function refreshMarketFactsAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const config = ebayDecisionsConfig();
  if (!config) return { ok: false, message: "The live EbayDecisions integration is not configured. CSV/XLSX market import is still available." };
  const keys = batchKeys(form.getAll("mpn").map(String));
  if (!keys.length) return { ok: false, message: "No MPNs on this page to refresh." };
  if (keys.length > EBAYDECISIONS_MAX_MPNS) return { ok: false, message: `At most ${EBAYDECISIONS_MAX_MPNS} MPNs per refresh.` };
  let facts;
  try {
    facts = await fetchMarketFacts(config, keys);
  } catch (error) {
    // Only our own fixed messages are shown; nothing here can carry the API key.
    return { ok: false, message: error instanceof EbayDecisionsError ? error.message : "EbayDecisions refresh failed. Nothing was saved." };
  }
  const plan = planMarketFacts(keys, facts);
  await patchProviderMarketFacts(await getDb(), plan.sold, plan.active, EBAYDECISIONS_SOURCE);
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `Refreshed market facts for ${plan.refreshed.length} of ${keys.length} MPNs from EbayDecisions.`,
    details: [
      `Refreshed: ${plan.refreshed.length}.`,
      `Registered but no 90-day research: ${plan.noSold90.length}${plan.noSold90.length ? " (sold facts and research date left as they were)" : ""}.`,
      `Not registered in EbayDecisions: ${plan.unregistered.length}${plan.unregistered.length ? " (existing facts kept)" : ""}.`,
      `Failed: ${plan.failed.length}.`
    ]
  };
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
  const db = await getDb();
  // An unchanged researched value keeps its provenance; a typed value is manual.
  const existing = await getMarketFacts(db, canonicalizeMpn(mpn));
  const keepSource = existing?.sellThroughPct != null && sellThrough != null && Number(existing.sellThroughPct) === sellThrough;
  await upsertMarketFacts(db, [{
    mpnCanonical: canonicalizeMpn(mpn),
    mpnDisplay: mpn,
    description: null,
    sold90: num(form.get("sold90")),
    avgPrice: num(form.get("avgPrice")),
    avgShip: num(form.get("avgShip")),
    sellThroughPct: sellThrough,
    sellThroughSource: sellThrough == null ? null : keepSource ? existing?.sellThroughSource as "manual" | "research" : "manual",
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
    forceResearch: form.get("forceResearch") === "on",
    packagingCost: num(form.get("packagingCost")),
    strategicExceptionApproved: form.get("strategicExceptionApproved") === "on"
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
  const o = s.harvestOverhead;
  await saveSettings(db, {
    ...s,
    finalValueFeePct: n("finalValueFeePct", s.finalValueFeePct),
    promotedListingPct: n("promotedListingPct", s.promotedListingPct),
    marketplaceTaxPct: n("marketplaceTaxPct", s.marketplaceTaxPct),
    perOrderFee: n("perOrderFee", s.perOrderFee),
    defaultShipLabel: n("defaultShipLabel", s.defaultShipLabel),
    packShipLabor: n("packShipLabor", s.packShipLabor),
    laborRateHr: n("laborRateHr", s.laborRateHr),
    ordinarySold90Minimum: Math.round(n("ordinarySold90Minimum", s.ordinarySold90Minimum)),
    // Owner-set thresholds: blank means unset (SET_RULE), never a fallback value.
    minimumSellThroughPct: num(form.get("minimumSellThroughPct")),
    minimumProfitMarginPct: num(form.get("minimumProfitMarginPct")),
    harvestOverhead: {
      Refrigerator: n("overheadRefrigerator", o.Refrigerator),
      Washer: n("overheadWasher", o.Washer),
      Range: n("overheadRange", o.Range),
      Dryer: n("overheadDryer", o.Dryer),
      Dishwasher: n("overheadDishwasher", o.Dishwasher),
      fallback: n("overheadFallback", o.fallback)
    },
    machineOverhead: n("machineOverhead", s.machineOverhead),
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
