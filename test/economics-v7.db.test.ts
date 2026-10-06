import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { getSettings, mpnDetail, mpnIndex, saveModelBom, saveSettings, teardownQueue, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { mapMarketRows } from "@/src/lib/market-import";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { importMarketAction, saveMarketAction, saveMpnManualAction, saveSettingsAction } from "@/app/actions";

// Server actions run against this file's PGlite database.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const MIGRATIONS = path.join(__dirname, "..", "drizzle");
const NOW = new Date("2026-10-06T12:00:00Z");
const BOARD = "W11165528";
const PUMP = "W10006355";
let db: Db;

const part = (mpn: string, description: string, price: number): SupplierRow => ({
  mpnDisplay: mpn, mpnCanonical: mpn.replace(/[^A-Z0-9]/gi, "").toUpperCase(), description, diagramId: "1", supplierPartId: null, newPrice: price, nla: false
});
const chain = (rows: SupplierRow[]): ChainResult => ({
  status: "found",
  winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: [{ supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 }]
});
const washer = (id: number) =>
  ({ ID: id, Availability: "UNCHECKED", ApplianceType: "Washer - Top Load / No Agitator", Brand: "Maytag", ModelNumber: "MVWX655DW1", SerialNumber: "" });
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const facts = async (mpn: string) => (await db.select().from(schema.marketFacts)).find((r) => r.mpnCanonical === mpn)!;
const setRules = async (minimumSellThroughPct: number | null, minimumProfitMarginPct: number | null) =>
  saveSettings(db, { ...(await getSettings(db)), minimumSellThroughPct, minimumProfitMarginPct });

// Board: sold 3 but an enormous active count and stock on hand, which the old share/pull cap would zero out.
// Pump: sold and active counts but no exact sell-through in the file.
const MARKET_CSV = [
  "mpn,sold90,avg_price,avg_ship,sell_through_pct,active_qty,qty_on_hand",
  `${BOARD},3,95,12,40,1000,50`,
  `${PUMP},30,40,10,,200,`
].join("\n");
const PII_FILENAME = "Jane Placeholder jane.placeholder@example.com 555-0100 12 Example Ave.csv";

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  await upsertFleet(db, mapFleetRows([washer(1), washer(2), washer(3)], NOW).rows);
  await saveModelBom(db, {
    brandKey: "MAYTAG", modelKey: "MVWX655DW1", brandDisplay: "Maytag", modelDisplay: "MVWX655DW1",
    result: chain([part(BOARD, "Washer Electronic Control Board", 180), part("WPW10006355", "Drain Pump", 60)])
  });
});

describe("Store Economics v7 settings", () => {
  it("1. ships v7 planning defaults with both qualification thresholds unset → SET_RULE", async () => {
    const s = await getSettings(db);
    expect(s).toMatchObject({
      finalValueFeePct: 13.6, promotedListingPct: 3.62, marketplaceTaxPct: 6.56, perOrderFee: 0.4, defaultShipLabel: 9,
      packShipLabor: 1.5, laborRateHr: 15, ordinarySold90Minimum: 3, minimumSellThroughPct: null, minimumProfitMarginPct: null,
      harvestOverhead: { Refrigerator: 3.48, Washer: 4.65, Range: 5.07, Dryer: 5.43, Dishwasher: 5.91, fallback: 5.07 }
    });
    for (const legacy of ["feePct", "minSellThroughPct", "harvestCushion", "minProfit", "stockWindowDays", "defaultShipCost"]) expect(s).not.toHaveProperty(legacy);
  });

  it("blank thresholds stay blank after saving the Settings form", async () => {
    await saveSettingsAction(form({ minimumSellThroughPct: "", minimumProfitMarginPct: "", finalValueFeePct: "13.6", donorAvailabilities: "UNCHECKED, PARTS ONLY" }));
    expect(await getSettings(db)).toMatchObject({ minimumSellThroughPct: null, minimumProfitMarginPct: null, finalValueFeePct: 13.6 });
    await saveSettingsAction(form({ minimumSellThroughPct: "30", minimumProfitMarginPct: "25", donorAvailabilities: "UNCHECKED, PARTS ONLY" }));
    expect(await getSettings(db)).toMatchObject({ minimumSellThroughPct: 30, minimumProfitMarginPct: 25 });
    // Clearing a threshold unsets it; it never falls back to the previous or a default value.
    await saveSettingsAction(form({ minimumSellThroughPct: "", minimumProfitMarginPct: "25", donorAvailabilities: "UNCHECKED, PARTS ONLY" }));
    expect(await getSettings(db)).toMatchObject({ minimumSellThroughPct: null, minimumProfitMarginPct: 25 });
    await setRules(null, null);
  });
});

describe("market import semantics", () => {
  it("6. the uploaded filename is not stored; a PII-bearing filename cannot reach market_facts", async () => {
    const upload = new FormData();
    upload.set("file", new File([MARKET_CSV], PII_FILENAME, { type: "text/csv" }));
    const result = await importMarketAction(null, upload);
    expect(result).toMatchObject({ ok: true, message: "Saved market facts for 2 MPNs." });
    expect(result.details).toContain("1 have no exact-MPN sell-through in the file; left blank (needs research).");
    const rows = await db.select().from(schema.marketFacts);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["market_import"]));
    const stored = JSON.stringify(rows);
    for (const pii of [PII_FILENAME, "Jane Placeholder", "jane.placeholder@example.com", "555-0100", "Example Ave", "import:"]) {
      expect(stored).not.toContain(pii);
    }
  });

  it("3/4. sell-through is never derived; sold90 and activeQty stay separate stored facts", async () => {
    expect(await facts(PUMP)).toMatchObject({ sold90: 30, activeQty: 200, sellThroughPct: null, sellThroughSource: null });
    expect(await facts(BOARD)).toMatchObject({ sold90: 3, activeQty: 1000, sellThroughPct: "40.00", sellThroughSource: "research" });
    // The mapper itself never fills it in either, whatever the counts.
    const { rows } = mapMarketRows([{ mpn: "X1", sold90: 30, active_qty: 70, avg_price: 50 }]);
    expect(rows[0]).toMatchObject({ sold90: 30, activeQty: 70, sellThroughPct: null, sellThroughSource: null });
  });

  it("5. manual entry marks sell-through manual; an unchanged researched value keeps research provenance", async () => {
    const page = (p: Record<string, string>) => saveMarketAction(form({
      mpn: BOARD, sold90: "3", avgPrice: "95", avgShip: "12", activeQty: "1000", qtyOnHand: "50", researchedAt: "2026-10-01", ...p
    }));
    await page({ sellThroughPct: "40" });
    expect(await facts(BOARD)).toMatchObject({ sellThroughPct: "40.00", sellThroughSource: "research", source: "manual" });
    await page({ sellThroughPct: "41" });
    expect(await facts(BOARD)).toMatchObject({ sellThroughPct: "41.00", sellThroughSource: "manual" });
    await page({ sellThroughPct: "" });
    expect(await facts(BOARD)).toMatchObject({ sellThroughPct: null, sellThroughSource: null, sold90: 3, activeQty: 1000 });
    await page({ sellThroughPct: "40" });
    expect(await facts(BOARD)).toMatchObject({ sellThroughPct: "40.00", sellThroughSource: "manual" });
    // The database refuses sell-through without provenance.
    await expect(db.execute(sql`update market_facts set sell_through_source = null where mpn_canonical = ${BOARD}`)).rejects.toThrow();
  });
});

describe("qualification and teardown on stored data", () => {
  it("1/15. rules unset: researched MPNs are SET_RULE and teardown ranking is disabled", async () => {
    const { rows, rulesSet } = await mpnIndex(db, { view: "all" });
    expect(rulesSet).toBe(false);
    expect(rows.map((r) => [r.mpn_canonical, r.qualification?.result]).sort()).toEqual([[PUMP, "SET_RULE"], [BOARD, "SET_RULE"]].sort());
    expect(await teardownQueue(db)).toMatchObject({ status: "set_rule", rows: [], qualified: 0 });
  });

  it("12. missing exact sell-through returns NEEDS_DATA after the rules are configured", async () => {
    await setRules(30, 25);
    const pump = (await mpnDetail(db, PUMP))!.mpn.qualification;
    expect(pump).toMatchObject({ result: "NEEDS_DATA", missing: ["sell_through"], modeledValueSlotDay: null });
  });

  it("7. sold 3 meets the ordinary minimum; a strategic exception set on the MPN page waives only that gate", async () => {
    expect((await mpnDetail(db, BOARD))!.mpn.qualification?.result).toBe("QUALIFIED");
    await db.update(schema.marketFacts).set({ sold90: 2 }).where(sql`mpn_canonical = ${BOARD}`);
    expect((await mpnDetail(db, BOARD))!.mpn.qualification).toMatchObject({ result: "NOT_QUALIFIED", failed: ["sold_count"] });
    await saveMpnManualAction(form({ mpn: BOARD, removalMin: "", packagingCost: "2.50", strategicExceptionApproved: "on" }));
    const d = (await mpnDetail(db, BOARD))!.mpn;
    expect(d).toMatchObject({ strategic_exception_approved: true, packaging_cost: "2.50" });
    expect(d.qualification).toMatchObject({ result: "QUALIFIED", economics: { packaging: 2.5 } });
    await saveMpnManualAction(form({ mpn: BOARD, removalMin: "", packagingCost: "" }));
    expect((await mpnDetail(db, BOARD))!.mpn).toMatchObject({ strategic_exception_approved: false, packaging_cost: null });
    await db.update(schema.marketFacts).set({ sold90: 3 }).where(sql`mpn_canonical = ${BOARD}`);
  });

  it("2. old 20% / $20 / $1 / 25% prototype settings do not decide qualification", async () => {
    const snapshot = async () => (await mpnIndex(db, { view: "all" })).rows.map((r) => [r.mpn_canonical, r.qualification]);
    const before = await snapshot();
    await db.execute(sql`update settings set fee_pct = 99, min_sell_through_pct = 99, harvest_cushion = 100000, min_profit = 100000,
      default_ship_cost = 5000, stock_window_days = 1`);
    expect(await snapshot()).toEqual(before);
    await db.execute(sql`update settings set fee_pct = 0, min_sell_through_pct = 0, harvest_cushion = 0, min_profit = -100000`);
    await setRules(null, null);
    expect((await mpnIndex(db, { view: "all" })).rows.every((r) => r.qualification?.result === "SET_RULE")).toBe(true);
    await setRules(30, 25);
    expect(await snapshot()).toEqual(before);
  });

  it("16. teardown lists every donor of a qualified part: no sold/active share, pull cap or stock target", async () => {
    const first = await teardownQueue(db);
    expect(first.status).toBe("ok");
    // Old cap: ceil(3 × min(1, 3/1000) × 30 / 90) − 50 on hand → 0 pulls. Now all three donors are listed.
    expect(first.rows.map((r) => r.machine_no)).toEqual(["1", "2", "3"]);
    const line = first.rows[0].lines[0];
    expect(line).toMatchObject({ mpn_canonical: BOARD, break_even: 9.51, contribution: 70, margin_pct: 65.42 });
    expect(line.modeled_value_slot_day).toBeCloseTo((85.49 * 0.4) / 90, 4);
    // Active count and stock on hand do not move the teardown layer.
    await db.update(schema.marketFacts).set({ activeQty: 1, qtyOnHand: 0 }).where(sql`mpn_canonical = ${BOARD}`);
    expect(await teardownQueue(db)).toEqual(first);
    await db.update(schema.marketFacts).set({ activeQty: null }).where(sql`mpn_canonical = ${BOARD}`);
    expect(await teardownQueue(db)).toEqual(first);
  });

  it("15. only QUALIFIED MPNs enter teardown", async () => {
    await setRules(41, 25);
    expect(await teardownQueue(db)).toMatchObject({ status: "ok", rows: [], qualified: 0 });
    await setRules(null, 25);
    expect((await teardownQueue(db)).status).toBe("set_rule");
  });
});

describe("migration 0002 on pre-v7 data", () => {
  const statements = (file: string) =>
    readFileSync(path.join(MIGRATIONS, file), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);

  it("clears derived sell-through, labels provenance, scrubs filenames and leaves thresholds unset", async () => {
    const client = new PGlite();
    for (const f of ["0000_init.sql", "0001_roadrunner_sale_events.sql"]) for (const st of statements(f)) await client.exec(st);
    await client.exec(`
      insert into settings (id, fee_pct, min_sell_through_pct, harvest_cushion, min_profit) values (1, 25, 20, 20, 1);
      insert into market_facts (mpn_canonical, sold_90, active_qty, sell_through_pct, source) values
        ('A1', 10, 40, 20.00, 'import:Jane Placeholder orders.csv (sell-through derived)'),
        ('B2', 42, 60, 35.00, 'decision_workbook'),
        ('C3', 5, null, 22.00, 'manual'),
        ('D4', 8, 8, 50.00, 'decision_workbook (sell-through derived)'),
        ('E5', 9, null, null, 'import:Jane Placeholder.xlsx');`);
    for (const st of statements("0002_economics_v7.sql")) await client.exec(st);

    const res = await client.query<{ mpn_canonical: string; sold_90: number; active_qty: number | null; sell_through_pct: string | null; sell_through_source: string | null; source: string }>(
      "select mpn_canonical, sold_90, active_qty, sell_through_pct, sell_through_source, source from market_facts order by 1");
    expect(res.rows).toEqual([
      { mpn_canonical: "A1", sold_90: 10, active_qty: 40, sell_through_pct: null, sell_through_source: null, source: "market_import" },
      { mpn_canonical: "B2", sold_90: 42, active_qty: 60, sell_through_pct: "35.00", sell_through_source: "research", source: "decision_workbook" },
      { mpn_canonical: "C3", sold_90: 5, active_qty: null, sell_through_pct: "22.00", sell_through_source: "manual", source: "manual" },
      { mpn_canonical: "D4", sold_90: 8, active_qty: 8, sell_through_pct: null, sell_through_source: null, source: "decision_workbook" },
      { mpn_canonical: "E5", sold_90: 9, active_qty: null, sell_through_pct: null, sell_through_source: null, source: "market_import" }
    ]);
    const settings = await client.query<Record<string, string | null>>(
      "select fee_pct, min_profit, minimum_sell_through_pct, minimum_profit_margin_pct, final_value_fee_pct, overhead_washer from settings");
    expect(settings.rows[0]).toEqual({
      fee_pct: "25.00", min_profit: "1.00", minimum_sell_through_pct: null, minimum_profit_margin_pct: null, final_value_fee_pct: "13.60", overhead_washer: "4.65"
    });
    const mpn = await client.query("select column_name from information_schema.columns where table_name = 'mpn_master' and column_name in ('packaging_cost','strategic_exception_approved') order by 1");
    expect(mpn.rows).toEqual([{ column_name: "packaging_cost" }, { column_name: "strategic_exception_approved" }]);
    await client.close();
  });
});
