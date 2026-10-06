import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  getSettings, mpnDetail, mpnIndex, saveModelBom, saveSettings, setPartState, upsertFleet, upsertMarketFacts, upsertSaleEvents
} from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { classifyMachineMatch, type MachineMatch, type MachineMatchRow } from "@/src/lib/harvest-candidates";
import { mapMarketRows } from "@/src/lib/market-import";
import type { SaleRow } from "@/src/lib/sales-import";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";

let db: Db;
const NOW = new Date("2026-10-06T12:00:00Z");
const BOARD = "W11165528";
const PUMP = "W10006355";
const LID_LOCK = "W10820048";

const part = (mpn: string, description: string, price: number | null = 80): SupplierRow => ({
  mpnDisplay: mpn, mpnCanonical: mpn.replace(/[^A-Z0-9]/gi, "").toUpperCase(), description, diagramId: "1", supplierPartId: null, newPrice: price, nla: false
});
const chain = (rows: SupplierRow[]): ChainResult => ({
  status: "found",
  winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: [{ supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 }]
});
const machine = (id: number, model: string, brand: string, availability: string, serial: string, diagnosis = "") => ({
  ID: id, Availability: availability, ApplianceType: "Washer - Top Load / No Agitator", Brand: brand, ModelNumber: model, SerialNumber: serial, Diagnosis: diagnosis
});
const sale = (id: string, soldAt: string, quantity: number, itemPrice: number): SaleRow => ({
  sourceEventId: id, mpnCanonical: BOARD, mpnDisplay: BOARD, soldAt, quantity, itemPrice, listedAt: null, daysToSell: null, daysToSellSource: null
});

const ids = (xs: MachineMatch[]) => xs.map((x) => x.machine_no).sort();
const harvest = async (mpn: string) => (await mpnDetail(db, mpn))!.harvest;
const marketRows = () => db.select().from(schema.marketFacts).orderBy(schema.marketFacts.mpnCanonical);
const salesRows = () => db.select().from(schema.roadrunnerSaleEvents).orderBy(schema.roadrunnerSaleEvents.sourceEventId);
let before: { market: unknown; sales: unknown; roadrunner: unknown; index: Awaited<ReturnType<typeof mpnIndex>> };

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });

  await upsertFleet(db, mapFleetRows([
    machine(101, "MVWX655DW1", "Maytag", "UNCHECKED", "AAA111"),
    machine(102, "MVWX655DW1", "Maytag", "UNCHECKED", "BBB222", "No power, dead"),
    machine(103, "MVWX655DW1", "Maytag", "UNCHECKED", ""),
    machine(104, "MVWX655DW1", "Maytag", "UNCHECKED", "CCC333"),
    machine(105, "MVWX655DW1", "Maytag", "UNCHECKED", "CCC333"),
    machine(106, "MVWX655DW1", "Maytag", "PARTS ONLY", "DDD444"),
    machine(201, "WTW5000DW1", "Whirlpool", "PARTS ONLY", ""),
    machine(202, "WTW5000DW1", "Whirlpool", "READY TO SALE", "EEE555"),
    machine(301, "NO NAMEPLATE", "GE", "UNCHECKED", ""),
    machine(401, "WTW9999XX1", "Whirlpool", "UNCHECKED", "MVWX655DW1")
  ], NOW).rows);
  const shared = [part(BOARD, "Washer Electronic Control Board", 180), part("WPW10006355", "Drain Pump", 60), part("W10189966", "Hex Screw", 4)];
  await saveModelBom(db, { brandKey: "MAYTAG", modelKey: "MVWX655DW1", brandDisplay: "Maytag", modelDisplay: "MVWX655DW1", result: chain(shared) });
  await saveModelBom(db, { brandKey: "WHIRLPOOL", modelKey: "WTW5000DW1", brandDisplay: "Whirlpool", modelDisplay: "WTW5000DW1", result: chain([...shared, part(LID_LOCK, "Lid Lock", 70)]) });
  const { rows } = mapMarketRows([
    { MPN: BOARD, "Mkt Sold 90d": 42, "Mkt 90d Sell-Through": 0.35, "Mkt Active Listings (derived)": 60, "Mkt Price": 95, "Mkt Ship": 12, "Qty On Hand": 0 },
    { MPN: "WPW10006355", "Mkt Sold 90d": 30, "Mkt 90d Sell-Through": 0.1, "Mkt Active Listings (derived)": 200, "Mkt Price": 40, "Mkt Ship": 10 }
  ]);
  await upsertMarketFacts(db, rows.map((r) => ({ ...r, researchedAt: "2026-10-01" })), "decision_workbook");
  await upsertSaleEvents(db, [sale("ORD-A", "2026-09-11", 2, 120), sale("ORD-B", "2026-10-05", 1, 114)]);

  before = {
    market: await marketRows(), sales: await salesRows(),
    roadrunner: (await mpnDetail(db, BOARD))!.roadrunner, index: await mpnIndex(db, { view: "all" }, 100000)
  };
});

describe("MPN harvest candidates on the lot", () => {
  it("1. one MPN in several model BOMs returns machines from every owned matching model", async () => {
    const d = (await mpnDetail(db, BOARD))!;
    expect(d.machines.map((m) => m.machine_no).sort()).toEqual(["101", "102", "103", "104", "105", "106", "201", "202"]);
    expect(d.harvest.counts.models).toBe(2);
    expect(new Set(d.machines.map((m) => m.model_key))).toEqual(new Set(["MVWX655DW1", "WTW5000DW1"]));
    // The lid lock is only on the Whirlpool BOM.
    expect(ids((await harvest(LID_LOCK)).harvestCandidates)).toEqual(["201"]);
    expect((await harvest(LID_LOCK)).counts).toEqual({ harvestCandidates: 1, testFirst: 0, unavailable: 1, models: 1 });
  });

  it("2. a donor-status machine with no part state is a normal harvest candidate", async () => {
    const h = await harvest(BOARD);
    expect(ids(h.harvestCandidates)).toEqual(["101", "103", "104", "105", "106", "201"]);
    expect(h.harvestCandidates.find((m) => m.machine_no === "101")).toMatchObject({ candidate: "harvest_candidate", reasons: [], state: null });
  });

  it("3. a suspect failure symptom for that family makes the machine TEST FIRST, not a candidate", async () => {
    const h = await harvest(BOARD);
    expect(ids(h.testFirst)).toEqual(["102"]);
    expect(h.testFirst[0].reasons).toEqual(["Failure symptom flags control_board; test the part before counting it."]);
    expect(ids(h.harvestCandidates)).not.toContain("102");
    // The same machine is a normal candidate for a part outside its suspect families.
    expect(ids((await harvest(PUMP)).harvestCandidates)).toContain("102");
  });

  it("4. pulled, failed, missing and skip move the machine to not available with the reason", async () => {
    const states = { "103": "pulled", "104": "failed", "105": "missing", "106": "skip" } as const;
    for (const [m, s] of Object.entries(states)) await setPartState(db, m, BOARD, s);
    // A test-first machine whose part was pulled is no longer test first either.
    await setPartState(db, "102", BOARD, "pulled");

    const h = await harvest(BOARD);
    expect(ids(h.harvestCandidates)).toEqual(["101", "201"]);
    expect(h.testFirst).toEqual([]);
    expect(ids(h.unavailable)).toEqual(["102", "103", "104", "105", "106", "202"]);
    for (const [m, s] of Object.entries(states)) {
      expect(h.unavailable.find((x) => x.machine_no === m)).toMatchObject({ state: s, reasons: [`Part already recorded as ${s} on this machine.`] });
    }
    expect(h.counts).toEqual({ harvestCandidates: 2, testFirst: 0, unavailable: 6, models: 2 });
    for (const m of ["102", ...Object.keys(states)]) await setPartState(db, m, BOARD, null);
  });

  it("5. a non-donor availability stays visible but is not actionable", async () => {
    const h = await harvest(BOARD);
    expect(h.unavailable.map((m) => [m.machine_no, m.availability, m.reasons])).toEqual([
      ["202", "READY TO SALE", ["Availability READY TO SALE is not a donor status."]]
    ]);
  });

  it("6. two identical-model machines are independent candidates by machine ID", async () => {
    await setPartState(db, "101", BOARD, "pulled");
    const h = await harvest(BOARD);
    expect(h.unavailable.find((m) => m.machine_no === "101")?.state).toBe("pulled");
    expect(h.harvestCandidates.find((m) => m.machine_no === "103")).toMatchObject({ model_key: "MVWX655DW1", state: null });
    await setPartState(db, "101", BOARD, null);
  });

  it("7. serial never affects reverse BOM matching", async () => {
    const rowsBefore = (await mpnDetail(db, BOARD))!.machines;
    // 401's serial is a BOM model number; it is still not matched. Re-serialing 101 changes nothing else.
    expect(rowsBefore.map((m) => m.machine_no)).not.toContain("401");
    await upsertFleet(db, mapFleetRows([machine(101, "MVWX655DW1", "Maytag", "UNCHECKED", "ZZZ999")], NOW).rows);
    const after = await harvest(BOARD);
    expect(ids(after.harvestCandidates)).toEqual(["101", "103", "104", "105", "106", "201"]);
    expect((await mpnDetail(db, BOARD))!.machines).toEqual(rowsBefore);
    // Same-model machines with empty, shared or different serials all match.
    expect(rowsBefore.filter((m) => m.model_key === "MVWX655DW1")).toHaveLength(6);
  });

  it("9. the global donor count keeps its meaning (donor status, no part state, test-first included)", async () => {
    const d = (await mpnDetail(db, BOARD))!;
    expect(d.mpn.donors).toBe(7);
    expect(d.mpn.donors).toBe(d.harvest.counts.harvestCandidates + d.harvest.counts.testFirst);
    await setPartState(db, "104", BOARD, "failed");
    expect((await mpnDetail(db, BOARD))!.mpn.donors).toBe(6);
    await setPartState(db, "104", BOARD, null);
    const index = await mpnIndex(db, { view: "all" }, 100000);
    expect(index.rows.map((r) => [r.mpn_canonical, r.donors])).toEqual(before.index.rows.map((r) => [r.mpn_canonical, r.donors]));
  });

  it("10. no GREENLIGHT/REJECT threshold decides who is a harvest candidate", async () => {
    const board = (await mpnDetail(db, BOARD))!;
    const pump = (await mpnDetail(db, PUMP))!;
    const lid = (await mpnDetail(db, LID_LOCK))!;
    expect([board.mpn.verdict?.verdict, pump.mpn.verdict?.verdict, lid.mpn.verdict]).toEqual(["GREENLIGHT", "REJECT", null]);
    // Same physical rules for a greenlit, a rejected and an unresearched part.
    expect(ids(pump.harvest.harvestCandidates)).toEqual(["101", "102", "103", "104", "105", "106", "201"]);
    expect(ids(lid.harvest.harvestCandidates)).toEqual(["201"]);

    const s = await getSettings(db);
    await saveSettings(db, { ...s, minProfit: 100000, minSellThroughPct: 99 });
    const strict = (await mpnDetail(db, BOARD))!;
    expect(strict.mpn.verdict?.verdict).toBe("REJECT");
    expect(strict.harvest).toEqual(board.harvest);
    await saveSettings(db, s);
  });

  it("8. Roadrunner sales history and market facts are unchanged", async () => {
    expect(await marketRows()).toEqual(before.market);
    expect(await salesRows()).toEqual(before.sales);
    expect((await mpnDetail(db, BOARD))!.roadrunner).toEqual(before.roadrunner);
    const index = await mpnIndex(db, { view: "all" }, 100000);
    expect(index.rows.map((r) => [r.mpn_canonical, r.verdict, r.market])).toEqual(before.index.rows.map((r) => [r.mpn_canonical, r.verdict, r.market]));
  });
});

describe("classifyMachineMatch", () => {
  const row: MachineMatchRow = {
    machine_no: "1", availability: "UNCHECKED", appliance_type: "", brand: "GE", brand_key: "GE", model_raw: "X", model_key: "X",
    diagram_id: "1", age_candidate_years: [], suspect_families: ["control_board"], identity_status: "ok", state: null
  };
  const donors = ["UNCHECKED", "PARTS ONLY"];

  it("marks unusable identity unavailable and lists every reason", () => {
    expect(classifyMachineMatch({ ...row, identity_status: "needs_nameplate" }, "pump", donors))
      .toMatchObject({ candidate: "unavailable", reasons: ["Model unreadable: needs nameplate."] });
    expect(classifyMachineMatch({ ...row, availability: "SOLD", state: "skip" }, "control_board", donors).reasons).toEqual([
      "Part already recorded as skip on this machine.", "Availability SOLD is not a donor status."
    ]);
  });

  it("separates test first from normal candidates by part family", () => {
    expect(classifyMachineMatch(row, "control_board", donors).candidate).toBe("test_first");
    expect(classifyMachineMatch(row, "pump", donors).candidate).toBe("harvest_candidate");
  });
});
