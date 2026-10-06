import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  addAlias, fleetSummary, getSettings, machineDetail, modelsNeedingBom, mpnDetail, mpnIndex,
  saveModelBom, saveSettings, setPartState, teardownQueue, upsertFleet, upsertMarketFacts
} from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { mapMarketRows } from "@/src/lib/market-import";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";

let db: Db;
const NOW = new Date("2026-10-06T12:00:00Z");

const row = (mpn: string, description: string, price: number | null = 80): SupplierRow => ({
  mpnDisplay: mpn, mpnCanonical: mpn.replace(/[^A-Z0-9]/gi, "").toUpperCase(), description, diagramId: "1", supplierPartId: null, newPrice: price, nla: false
});
const chain = (rows: SupplierRow[]): ChainResult => ({
  status: "found",
  winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: [{ supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 }]
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });

  const fleet = mapFleetRows([
    { ID: 1, Availability: "UNCHECKED", ApplianceType: "Washer - Top Load / No Agitator", Brand: "Maytag", ModelNumber: "MVWX655DW1", SerialNumber: "CD2412345" },
    { ID: 2, Availability: "UNCHECKED", ApplianceType: "Washer - Top Load / No Agitator", Brand: "Maytag", ModelNumber: "MVWX655DW1", SerialNumber: "SU1727374", Diagnosis: "No power, dead" },
    { ID: 3, Availability: "PARTS ONLY", ApplianceType: "Washer - Top Load / No Agitator", Brand: "Whirlpool", ModelNumber: "WTW5000DW1", SerialNumber: "" },
    { ID: 4, Availability: "READY TO SALE", ApplianceType: "Washer - Top Load / No Agitator", Brand: "Whirlpool", ModelNumber: "WTW5000DW1", SerialNumber: "" },
    { ID: 5, Availability: "UNCHECKED", ApplianceType: "Range - Drop In", Brand: "GE", ModelNumber: "NO NAMEPLATE", SerialNumber: "" }
  ], NOW).rows;
  await upsertFleet(db, fleet);
});

describe("pipeline on a real Postgres (PGlite)", () => {
  it("queues models by machine count, excluding non-donors and unreadable models", async () => {
    const s = await getSettings(db);
    const models = await modelsNeedingBom(db, {}, s.donorAvailabilities);
    expect(models.map((m) => [m.model_key, m.machines])).toEqual([["MVWX655DW1", 2], ["WTW5000DW1", 1]]);
  });

  it("stores parts lists once per model and resolves WP aliases", async () => {
    const shared = [row("W11165528", "Washer Electronic Control Board", 180), row("WPW10006355", "Drain Pump", 60), row("W10189966", "Hex Screw", 4)];
    const a = await saveModelBom(db, { brandKey: "MAYTAG", modelKey: "MVWX655DW1", brandDisplay: "Maytag", modelDisplay: "MVWX655DW1", result: chain(shared) });
    expect(a).toEqual({ rows: 3, newMpns: 3 });
    const b = await saveModelBom(db, { brandKey: "WHIRLPOOL", modelKey: "WTW5000DW1", brandDisplay: "Whirlpool", modelDisplay: "WTW5000DW1", result: chain([...shared, row("W10820048", "Lid Lock", 70)]) });
    expect(b.newMpns).toBe(1);
    const detail = await mpnDetail(db, "WPW10006355");
    expect(detail?.mpn.mpn_canonical).toBe("W10006355");
    expect(detail?.aliases.map((x) => x.kind)).toEqual(["wp_prefix"]);
  });

  it("counts donors across all compatible models (in-fleet fitment)", async () => {
    const { rows, counts } = await mpnIndex(db, {});
    const board = rows.find((r) => r.mpn_canonical === "W11165528");
    // machines 1, 2 (Maytag) + 3 (Whirlpool PARTS ONLY); 4 is READY TO SALE so not a donor
    expect(board).toMatchObject({ donors: 3, models: 2 });
    expect(rows.find((r) => r.mpn_canonical === "W10189966")?.prefilter).toMatch(/fastener/);
    expect(counts.queue).toBe(3);
  });

  it("imports market facts (workbook fraction sell-through) and qualifies under v7 once rules are set", async () => {
    const { rows } = mapMarketRows([
      { MPN: "W11165528", "Mkt Sold 90d": 42, "Mkt 90d Sell-Through": 0.35, "Mkt Active Listings (derived)": 60, "Mkt Price": 95, "Mkt Ship": 12, "Qty On Hand": 0 },
      { MPN: "WPW10006355", "Mkt Sold 90d": 30, "Mkt 90d Sell-Through": 0.1, "Mkt Active Listings (derived)": 200, "Mkt Price": 40, "Mkt Ship": 10 }
    ]);
    expect(rows[0]).toMatchObject({ sellThroughPct: 35, sellThroughSource: "research" });
    await upsertMarketFacts(db, rows.map((r) => ({ ...r, researchedAt: "2026-10-01" })), "decision_workbook");
    // Rules unset: no verdict is invented.
    expect((await mpnIndex(db, { view: "qualified" })).rows).toEqual([]);
    expect((await mpnIndex(db, { view: "set_rule" })).rows.map((r) => r.mpn_canonical).sort()).toEqual(["W10006355", "W11165528"]);

    await saveSettings(db, { ...(await getSettings(db)), minimumSellThroughPct: 30, minimumProfitMarginPct: 25 });
    const { rows: qualified } = await mpnIndex(db, { view: "qualified" });
    expect(qualified.map((r) => r.mpn_canonical)).toEqual(["W11165528"]);
    // Washer board: P 95 + B 12, label $9 default, 10 min removal ($2.50), washer overhead $4.65.
    expect(qualified[0].qualification).toMatchObject({
      result: "QUALIFIED", economics: { fees: 19.35, contribution: 70, marginPct: 65.42, breakEven: 9.51, removalLabor: 2.5, machineOverhead: 4.65 }
    });
    const { rows: rejects } = await mpnIndex(db, { view: "not_qualified" });
    expect(rejects.map((r) => [r.mpn_canonical, r.qualification?.result === "NOT_QUALIFIED" && r.qualification.failed])).toEqual([["W10006355", ["sell_through"]]]);
  });

  it("builds the teardown queue from qualified parts and keeps failure-suspect parts out of the ordering", async () => {
    const { status, rows } = await teardownQueue(db);
    expect(status).toBe("ok");
    const byMachine = Object.fromEntries(rows.map((r) => [r.machine_no, r]));
    expect(byMachine["1"].lines.map((l) => l.mpn_canonical)).toEqual(["W11165528"]);
    expect(byMachine["3"].lines.map((l) => l.mpn_canonical)).toEqual(["W11165528"]);
    // (95 − 9.51) × 35% ÷ 90
    expect(byMachine["1"].order_value).toBeCloseTo((85.49 * 0.35) / 90, 4);
    // machine 2 diagnosis "no power, dead" → control board is suspect → not counted
    expect(byMachine["2"]).toBeUndefined();
  });

  it("a pulled part stops showing as available on that machine", async () => {
    await setPartState(db, "1", "W11165528", "pulled");
    const { rows } = await teardownQueue(db);
    expect(rows.map((r) => r.machine_no)).toEqual(["3"]);
    const detail = await machineDetail(db, "1");
    expect(detail?.parts.find((p) => p.mpn_canonical === "W11165528")?.state).toBe("pulled");
    await setPartState(db, "1", "W11165528", null);
  });

  it("manual supersession aliases resolve on lookup", async () => {
    await addAlias(db, "W10000001", "W11165528", "supersedes");
    const d = await mpnDetail(db, "w10000001");
    expect(d?.mpn.mpn_canonical).toBe("W11165528");
  });

  it("summarises the fleet with age bands", async () => {
    const s = await fleetSummary(db);
    expect(s.totals).toMatchObject({ machines: 5, needs_nameplate: 1, models_with_bom: 2 });
    const washers = s.bandMatrix.find((r) => r.type.startsWith("Washer"));
    expect(washers?.counts["2020+"]).toBe(1);
  });
});
