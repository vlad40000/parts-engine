"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/src/db";
import {
  addAlias, getMarketFacts, getSettings, mpnRowsFor, patchProviderMarketFacts, saveSettings, setPartState, updateMpnManual, upsertBaseline, upsertFleet,
  upsertMarketFacts, upsertSaleEvents
} from "@/src/db/queries";
import { parseCsvRecords } from "@/src/lib/csv";
import { mapFleetRows, readFleetFile } from "@/src/lib/fleet-import";
import { mapMarketRows, MARKET_IMPORT_SOURCE } from "@/src/lib/market-import";
import { ensureMachineBom } from "@/src/lib/model-bom";
import {
  batchKeys, EBAYDECISIONS_MAX_MPNS, EBAYDECISIONS_RESEARCH_MAX_MPNS, EBAYDECISIONS_SOURCE, EbayDecisionsError, ebayDecisionsConfig, fetchMarketFacts,
  planMarketFacts, registerMpns, registrationPayload, researchCounts, researchMpns, type MarketFactsPlan, type ResearchResult
} from "@/src/lib/ebaydecisions";
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

// Only our own fixed messages are shown; nothing here can carry the API key.
const providerMessage = (error: unknown, fallback: string) => (error instanceof EbayDecisionsError ? error.message : fallback);

/**
 * One-click exact-MPN research for the first 20 rendered research-queue MPNs (Integration A4).
 * Server-side, in order, no polling:
 * 1. register them in EbayDecisions with the display MPN and description only (insert-only there);
 * 2. ask EbayDecisions to research those D1 keys through the official eBay APIs;
 * 3. read the stored facts from the zero-write market-facts route, exactly as the A2 refresh does;
 * 4. write only the A2 provider-owned fields (planMarketFacts → patchProviderMarketFacts).
 * Research outcomes are reported, never stored. A failed registration stops before anything is
 * researched or saved. A failed or timed-out research call still ends in the stored-facts read, since
 * the provider saves each MPN as it goes; that read is validated on its own and saves nothing if it fails.
 */
export async function researchQueueAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const config = ebayDecisionsConfig();
  if (!config) return { ok: false, message: "The live EbayDecisions integration is not configured. CSV/XLSX market import is still available." };
  // Rendered queue order; never more than the research cap, however many MPNs were posted.
  const requested = batchKeys(form.getAll("mpn").map(String)).slice(0, EBAYDECISIONS_RESEARCH_MAX_MPNS);
  if (!requested.length) return { ok: false, message: "No queue MPNs on this page to research." };
  const db = await getDb();
  // Display MPN and description come from Parts Engine's own MPN index, not from the form.
  const before = await mpnRowsFor(db, requested);
  if (!before.length) return { ok: false, message: "None of these MPNs are in the MPN index. Nothing was sent." };
  const keys = before.map((r) => r.mpn_canonical);

  let registration;
  try {
    registration = await registerMpns(config, registrationPayload(before.map((r) => ({ mpnCanonical: r.mpn_canonical, mpnDisplay: r.mpn_display, description: r.description }))));
  } catch (error) {
    return { ok: false, message: providerMessage(error, "EbayDecisions registration failed. Nothing was researched or saved.") };
  }

  let research: ResearchResult[] | null = null;
  let researchError = "";
  try {
    research = await researchMpns(config, keys);
  } catch (error) {
    researchError = providerMessage(error, "EbayDecisions research failed. No research outcome was read.");
  }

  let plan: MarketFactsPlan | null = null;
  let refreshError = "";
  try {
    plan = planMarketFacts(keys, await fetchMarketFacts(config, keys));
  } catch (error) {
    refreshError = providerMessage(error, "EbayDecisions refresh failed. Nothing was saved.");
  }
  if (plan) {
    await patchProviderMarketFacts(db, plan.sold, plan.active, EBAYDECISIONS_SOURCE);
    revalidatePath("/", "layout");
  }

  const n = keys.length;
  const c = researchCounts(registration, research ?? []);
  const after = await mpnRowsFor(db, keys);
  const result = (v: string) => after.filter((r) => r.qualification?.result === v).length;
  const missingStr = after.filter((r) => r.sell_through_pct == null).length;
  const details = [
    requested.length > n ? `Not in the MPN index, not sent: ${requested.length - n}.` : "",
    `Registered: ${c.inserted} new, ${c.existing} already in EbayDecisions (MPN and description only).`,
    ...(research ? [
      `Sold research saved: ${c.soldSaved}. Active research saved: ${c.activeSaved}.`,
      `Sold not saved: ${c.soldUnavailable} unavailable (no Marketplace Insights access), ${c.soldUnverified} unverified (exact MPN not confirmed).`,
      `Failed (nothing saved): ${c.failed}${c.unregistered ? `, ${c.unregistered} of them not registered` : ""}.`,
      ...c.notes.map(({ note, count }) => `EbayDecisions note (${count} MPN${count === 1 ? "" : "s"}): ${note}`)
    ] : [researchError]),
    ...(plan ? [
      `Market facts refreshed: ${plan.refreshed.length} of ${n} (90-day sold facts saved in Parts Engine).`,
      plan.noSold90.length ? `No 90-day sold research stored yet: ${plan.noSold90.length} (sold facts and research date left as they were).` : "",
      plan.unregistered.length ? `Not registered in EbayDecisions: ${plan.unregistered.length} (existing facts kept).` : "",
      plan.failed.length ? `Missing from the market facts response: ${plan.failed.length} (existing facts kept).` : ""
    ] : [refreshError]),
    missingStr ? `Exact sell-through still missing for ${missingStr} of ${n}. It is never derived, so these stay NEEDS DATA until EbayDecisions stores an exact value.` : "",
    `Qualification now: ${result("QUALIFIED")} qualified, ${result("NEEDS_DATA")} needs data, ${result("NOT_QUALIFIED")} not qualified, ${result("SET_RULE")} set rule, ${after.filter((r) => !r.qualification).length} without market facts.`
  ].filter(Boolean);

  const ofN = `${n} MPN${n === 1 ? "" : "s"}`;
  if (!plan) return { ok: false, message: "Market facts were not refreshed; nothing was saved in Parts Engine.", details };
  if (!research) return { ok: false, message: `Research did not complete; stored facts were still refreshed for ${plan.refreshed.length} of ${ofN}.`, details };
  return { ok: true, message: `Researched ${ofN} with EbayDecisions; market facts refreshed for ${plan.refreshed.length} of ${n}.`, details };
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
