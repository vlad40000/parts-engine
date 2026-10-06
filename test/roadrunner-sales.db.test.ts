import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq, sql } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  getSettings, machineDetail, modelsNeedingBom, mpnDetail, mpnIndex, roadrunnerPerformance,
  saveModelBom, setPartState, upsertFleet, upsertMarketFacts, upsertSaleEvents
} from "@/src/db/queries";
import { parseCsvRecords } from "@/src/lib/csv";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { mapMarketRows } from "@/src/lib/market-import";
import { mapSaleRows } from "@/src/lib/sales-import";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";

let db: Db;
const NOW = new Date("2026-10-06T12:00:00Z");

const part = (mpn: string, description: string, price: number | null = 80): SupplierRow => ({
  mpnDisplay: mpn, mpnCanonical: mpn.replace(/[^A-Z0-9]/gi, "").toUpperCase(), description, diagramId: "1", supplierPartId: null, newPrice: price, nla: false
});
const chain = (rows: SupplierRow[]): ChainResult => ({
  status: "found",
  winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: [{ supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 }]
});
const washer = (id: number, serial: string, model = "MVWX655DW1", brand = "Maytag") =>
  ({ ID: id, Availability: "UNCHECKED", ApplianceType: "Washer - Top Load / No Agitator", Brand: brand, ModelNumber: model, SerialNumber: serial });

// Placeholder buyer columns prove the importer ignores them; the values are not real people.
const SALES_CSV = [
  "Buyer Name,mpn,source_event_id,sold_at,quantity,item_price,listed_at,Buyer Email,Ship To ZIP",
  "Example Buyer,w11165528,ORD-A,2026-09-11,2,120.00,2026-09-01,buyer@example.com,00000",
  "Example Buyer,W-11165528,ORD-B,2026-10-05,1,114.00,,buyer@example.com,00000",
  "Example Buyer,W11 165 528,ORD-C,2026-08-20,3,118.00,2026-08-10,buyer@example.com,00000",
  "Example Buyer,DC47-00019A,ORD-D,2026-07-01,1,55.00,,buyer@example.com,00000",
  "Example Buyer,,ORD-E,2026-07-01,1,55.00,,buyer@example.com,00000",
  "Example Buyer,W10006355,,2026-07-01,1,55.00,,buyer@example.com,00000"
].join("\n");

const EXPECTED_BOARD = {
  mpnCanonical: "W11165528", unitsSold: 6, saleEvents: 3, avgItemPrice: 118, pricedUnits: 6,
  lastSoldAt: "2026-10-05", avgDaysToSell: 10, daysToSellEvents: 2, sources: ["roadrunner_csv"]
};

const allIndex = () => mpnIndex(db, { view: "all" }, 100000);
const greenIndex = () => mpnIndex(db, { view: "greenlight" }, 100000);
const marketRows = () => db.select().from(schema.marketFacts).orderBy(schema.marketFacts.mpnCanonical);
const masterRows = () => db.select().from(schema.mpnMaster).orderBy(schema.mpnMaster.mpnCanonical);
let before: { all: unknown; green: unknown; market: unknown; master: unknown };

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });

  await upsertFleet(db, mapFleetRows([
    washer(347, "AAA111"),
    washer(512, "BBB222"),
    { ...washer(600, "", "WTW5000DW1", "Whirlpool"), Availability: "PARTS ONLY" }
  ], NOW).rows);
  const shared = [part("W11165528", "Washer Electronic Control Board", 180), part("WPW10006355", "Drain Pump", 60), part("W10189966", "Hex Screw", 4)];
  await saveModelBom(db, { brandKey: "MAYTAG", modelKey: "MVWX655DW1", brandDisplay: "Maytag", modelDisplay: "MVWX655DW1", result: chain(shared) });
  await saveModelBom(db, { brandKey: "WHIRLPOOL", modelKey: "WTW5000DW1", brandDisplay: "Whirlpool", modelDisplay: "WTW5000DW1", result: chain([...shared, part("W10820048", "Lid Lock", 70)]) });
  const { rows } = mapMarketRows([
    { MPN: "W11165528", "Mkt Sold 90d": 42, "Mkt 90d Sell-Through": 0.35, "Mkt Active Listings (derived)": 60, "Mkt Price": 95, "Mkt Ship": 12, "Qty On Hand": 0 },
    { MPN: "WPW10006355", "Mkt Sold 90d": 30, "Mkt 90d Sell-Through": 0.1, "Mkt Active Listings (derived)": 200, "Mkt Price": 40, "Mkt Ship": 10 }
  ]);
  await upsertMarketFacts(db, rows.map((r) => ({ ...r, researchedAt: "2026-10-01" })), "decision_workbook");

  before = { all: await allIndex(), green: await greenIndex(), market: await marketRows(), master: await masterRows() };
});

describe("Roadrunner sales history by MPN, reused on machine BOMs", () => {
  it("1. attaches D1-normalized sales history to the same MPN", async () => {
    const mapped = mapSaleRows(parseCsvRecords(SALES_CSV));
    expect(mapped.skipped.map((s) => s.line)).toEqual([6, 7]);
    const res = await upsertSaleEvents(db, mapped.rows, { importedFrom: "sales-oct.csv" });
    expect(res).toEqual({ inserted: 4, updated: 0, notInAnyPartsList: 1 });

    const machine = await machineDetail(db, "347");
    const board = machine?.parts.find((p) => p.mpn_canonical === "W11165528");
    expect(board?.roadrunner).toEqual(EXPECTED_BOARD);
    // Parts with no recorded sales carry no aggregate, not a row of zeros.
    expect(machine?.parts.find((p) => p.mpn_canonical === "W10006355")?.roadrunner).toBeNull();

    const detail = await mpnDetail(db, "w11-165528");
    expect(detail?.roadrunner).toEqual(EXPECTED_BOARD);
    expect((await mpnDetail(db, "W10820048"))?.roadrunner).toBeNull();
  });

  it("stores no purchaser data", async () => {
    const cols = (await db.execute(sql`
      select column_name from information_schema.columns where table_name = 'roadrunner_sale_events' order by ordinal_position`)) as unknown as { rows: Array<{ column_name: string }> };
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      "source", "source_event_id", "mpn_canonical", "mpn_display", "sold_at", "quantity", "item_price",
      "listed_at", "days_to_sell", "days_to_sell_source", "imported_from", "created_at", "updated_at"
    ]);
    const stored = JSON.stringify(await db.select().from(schema.roadrunnerSaleEvents));
    for (const pii of ["Example Buyer", "buyer@example.com", "00000"]) expect(stored).not.toContain(pii);
  });

  it("2. re-importing the same sale events does not double-count them", async () => {
    const mapped = mapSaleRows(parseCsvRecords(SALES_CSV));
    const res = await upsertSaleEvents(db, mapped.rows, { importedFrom: "sales-oct-again.csv" });
    expect(res).toMatchObject({ inserted: 0, updated: 4 });
    expect(await db.$count(schema.roadrunnerSaleEvents)).toBe(4);
    expect((await roadrunnerPerformance(db, ["W11165528"])).get("W11165528")).toEqual(EXPECTED_BOARD);

    // A corrected re-import updates the event in place.
    const corrected = mapped.rows.map((r) => (r.sourceEventId === "ORD-B" ? { ...r, quantity: 2 } : r));
    await upsertSaleEvents(db, corrected);
    expect((await roadrunnerPerformance(db, ["W11165528"])).get("W11165528")).toMatchObject({ unitsSold: 7, saleEvents: 3 });
    await upsertSaleEvents(db, mapped.rows);
    expect((await roadrunnerPerformance(db, ["W11165528"])).get("W11165528")).toEqual(EXPECTED_BOARD);
  });

  it("3. two machines of the same model with different serials share one model BOM", async () => {
    const a = await machineDetail(db, "347");
    const b = await machineDetail(db, "512");
    expect([a?.machine.serial, b?.machine.serial]).toEqual(["AAA111", "BBB222"]);
    expect(a?.bom).toEqual(b?.bom);
    expect(a?.bom).toMatchObject({ brandKey: "MAYTAG", modelKey: "MVWX655DW1" });
    expect(a?.parts.map((p) => p.mpn_canonical).sort()).toEqual(b?.parts.map((p) => p.mpn_canonical).sort());
    expect(await db.$count(schema.modelBomCache, eq(schema.modelBomCache.modelKey, "MVWX655DW1"))).toBe(1);
  });

  it("4. those two machines keep independent part state", async () => {
    await setPartState(db, "347", "W11165528", "pulled");
    const a = await machineDetail(db, "347");
    const b = await machineDetail(db, "512");
    const boardA = a?.parts.find((p) => p.mpn_canonical === "W11165528");
    const boardB = b?.parts.find((p) => p.mpn_canonical === "W11165528");
    expect(boardA?.state).toBe("pulled");
    expect(boardB?.state).toBeNull();
    // The MPN's history is the same on both: it belongs to the part number, not the machine.
    expect(boardA?.roadrunner).toEqual(EXPECTED_BOARD);
    expect(boardB?.roadrunner).toEqual(EXPECTED_BOARD);
  });

  it("5. a newly added machine of a cached model sees existing history with no refetch or new research", async () => {
    const [cacheBefore] = await db.select().from(schema.modelBomCache)
      .where(and(eq(schema.modelBomCache.brandKey, "MAYTAG"), eq(schema.modelBomCache.modelKey, "MVWX655DW1")));
    const edgesBefore = await db.$count(schema.modelPartEdges);

    await upsertFleet(db, mapFleetRows([washer(901, "CCC333")], NOW).rows);
    const d = await machineDetail(db, "901");
    expect(d?.parts.find((p) => p.mpn_canonical === "W11165528")?.roadrunner).toEqual(EXPECTED_BOARD);
    expect(d?.bom).toEqual(cacheBefore);

    const s = await getSettings(db);
    expect((await modelsNeedingBom(db, {}, s.donorAvailabilities)).map((m) => m.model_key)).not.toContain("MVWX655DW1");
    expect(await db.$count(schema.modelPartEdges)).toBe(edgesBefore);
    expect(await marketRows()).toEqual(before.market);
  });

  it("6. reverse MPN -> machine lookup still works across models", async () => {
    const d = await mpnDetail(db, "W11165528");
    expect(d?.machines.map((m) => [m.machine_no, m.state])).toEqual(
      expect.arrayContaining([["347", "pulled"], ["512", null], ["600", null], ["901", null]])
    );
    expect(d?.machines).toHaveLength(4);
    expect(d?.models.map((m) => m.model_key)).toEqual(["MVWX655DW1", "WTW5000DW1"]);
    await setPartState(db, "347", "W11165528", null);
  });

  it("7. market facts and greenlight results are unchanged by sales history", async () => {
    expect(await marketRows()).toEqual(before.market);
    expect(await masterRows()).toEqual(before.master);
    // Test 5 added machine 901, so donor counts legitimately moved; every market/verdict field must not.
    type Index = Awaited<ReturnType<typeof allIndex>>;
    const strip = (x: Index) => ({ total: x.total, counts: x.counts, settings: x.settings, rows: x.rows.map(({ donors: _d, ...r }) => r) });
    expect(strip(await greenIndex())).toEqual(strip(before.green as Index));
    expect(strip(await allIndex())).toEqual(strip(before.all as Index));
    expect((await greenIndex()).rows.map((r) => [r.mpn_canonical, r.verdict])).toEqual([
      ["W11165528", expect.objectContaining({ verdict: "GREENLIGHT", profit: 45.75 })]
    ]);
  });
});
