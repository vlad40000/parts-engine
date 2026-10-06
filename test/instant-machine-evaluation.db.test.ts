import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { redirect } from "next/navigation";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  getSettings, machineDetail, modelsNeedingBom, mpnDetail, mpnIndex, saveModelBom, setPartState,
  upsertFleet, upsertMarketFacts, upsertSaleEvents
} from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { mapMarketRows } from "@/src/lib/market-import";
import type { SaleRow } from "@/src/lib/sales-import";
import { lookupModelBom, type ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { addMachineAction, importFleetAction } from "@/app/actions";
import { POST as bomRoute } from "@/app/api/bom/model/route";

// Server actions and the BOM route run against this file's PGlite database.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
// The real supplier chain runs; the spy only counts how often it is entered.
vi.mock("@/src/sources/chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/sources/chain")>();
  return { ...actual, lookupModelBom: vi.fn(actual.lookupModelBom) };
});

// Supplier HTTP is mocked; no live fetches. `supplier` picks how suppliers answer.
const page = readFileSync(path.join(__dirname, "fixtures", "encompass", "model-page.html"), "utf8");
let supplier: "found" | "not_found" | "error" = "found";
const supplierHttp = vi.fn(async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (supplier === "error") return new Response("", { status: 403 });
  if (url.includes("encompass")) return new Response(supplier === "found" ? page : "does not exist in our database", { status: 200 });
  return new Response("", { status: 404 });
});
vi.stubGlobal("fetch", supplierHttp);

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
const sale = (id: string, soldAt: string, quantity: number, itemPrice: number): SaleRow => ({
  sourceEventId: id, mpnCanonical: "W11165528", mpnDisplay: "W11165528", soldAt, quantity, itemPrice,
  listedAt: null, daysToSell: null, daysToSellSource: null
});
const machineForm = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
};
const addMachine = (fields: Record<string, string>) => addMachineAction(null, machineForm(fields));
const cacheRow = async (brandKey: string, modelKey: string) =>
  (await db.select().from(schema.modelBomCache)
    .where(and(eq(schema.modelBomCache.brandKey, brandKey), eq(schema.modelBomCache.modelKey, modelKey))))[0];
const edgesFor = (brandKey: string, modelKey: string) =>
  db.select().from(schema.modelPartEdges)
    .where(and(eq(schema.modelPartEdges.brandKey, brandKey), eq(schema.modelPartEdges.modelKey, modelKey)))
    .orderBy(schema.modelPartEdges.mpnCanonical);

const EXPECTED_BOARD = {
  mpnCanonical: "W11165528", unitsSold: 3, saleEvents: 2, avgItemPrice: 118, pricedUnits: 3,
  lastSoldAt: "2026-10-05", avgDaysToSell: null, daysToSellEvents: 0, sources: ["roadrunner_csv"]
};

const allIndex = () => mpnIndex(db, { view: "all" }, 100000);
const greenIndex = () => mpnIndex(db, { view: "greenlight" }, 100000);
const marketRows = () => db.select().from(schema.marketFacts).orderBy(schema.marketFacts.mpnCanonical);
const masterRows = () => db.select().from(schema.mpnMaster).orderBy(schema.mpnMaster.mpnCanonical);
const salesRows = () => db.select().from(schema.roadrunnerSaleEvents).orderBy(schema.roadrunnerSaleEvents.sourceEventId);
let before: {
  all: Awaited<ReturnType<typeof allIndex>>; green: Awaited<ReturnType<typeof greenIndex>>;
  market: unknown; master: Awaited<ReturnType<typeof masterRows>>; sales: unknown;
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });

  await upsertFleet(db, mapFleetRows([
    { ID: 347, Availability: "UNCHECKED", ApplianceType: "Washer - Top Load / No Agitator", Brand: "Maytag", ModelNumber: "MVWX655DW1", SerialNumber: "AAA111" }
  ], NOW).rows);
  await saveModelBom(db, {
    brandKey: "MAYTAG", modelKey: "MVWX655DW1", brandDisplay: "Maytag", modelDisplay: "MVWX655DW1",
    result: chain([part("W11165528", "Washer Electronic Control Board", 180), part("WPW10006355", "Drain Pump", 60), part("W10189966", "Hex Screw", 4)])
  });
  const { rows } = mapMarketRows([
    { MPN: "W11165528", "Mkt Sold 90d": 42, "Mkt 90d Sell-Through": 0.35, "Mkt Active Listings (derived)": 60, "Mkt Price": 95, "Mkt Ship": 12, "Qty On Hand": 0 },
    { MPN: "WPW10006355", "Mkt Sold 90d": 30, "Mkt 90d Sell-Through": 0.1, "Mkt Active Listings (derived)": 200, "Mkt Price": 40, "Mkt Ship": 10 }
  ]);
  await upsertMarketFacts(db, rows.map((r) => ({ ...r, researchedAt: "2026-10-01" })), "decision_workbook");
  await upsertSaleEvents(db, [sale("ORD-A", "2026-09-11", 2, 120), sale("ORD-B", "2026-10-05", 1, 114)]);

  before = { all: await allIndex(), green: await greenIndex(), market: await marketRows(), master: await masterRows(), sales: await salesRows() };
});

beforeEach(() => {
  vi.mocked(lookupModelBom).mockClear();
  vi.mocked(redirect).mockClear();
  supplierHttp.mockClear();
  supplier = "found";
});

describe("Add one machine evaluates instantly from the model BOM", () => {
  it("1. a cached model is reused: no refetch, no BOM change, Roadrunner history shows at once", async () => {
    const cacheBefore = await cacheRow("MAYTAG", "MVWX655DW1");
    const edgesBefore = await edgesFor("MAYTAG", "MVWX655DW1");

    await addMachine({ machineNo: "901", brand: "Maytag", model: "MVWX655DW1", serial: "CCC333", applianceType: "Washer - Top Load / No Agitator" });

    expect(redirect).toHaveBeenCalledWith("/machines/901");
    expect(lookupModelBom).not.toHaveBeenCalled();
    expect(supplierHttp).not.toHaveBeenCalled();
    expect(await cacheRow("MAYTAG", "MVWX655DW1")).toEqual(cacheBefore);
    expect(await edgesFor("MAYTAG", "MVWX655DW1")).toEqual(edgesBefore);

    const d = await machineDetail(db, "901");
    expect(d?.bom).toEqual(cacheBefore);
    expect(d?.parts.map((p) => p.mpn_canonical).sort()).toEqual(edgesBefore.map((e) => e.mpnCanonical));
    expect(d?.parts.find((p) => p.mpn_canonical === "W11165528")?.roadrunner).toEqual(EXPECTED_BOARD);
  });

  it("2. machines sharing the cached BOM keep their own machine_part_state", async () => {
    await setPartState(db, "901", "W11165528", "pulled");
    await setPartState(db, "347", "W10006355", "failed");
    const a = await machineDetail(db, "347");
    const b = await machineDetail(db, "901");
    const state = (d: typeof a, mpn: string) => d?.parts.find((p) => p.mpn_canonical === mpn)?.state;
    expect([state(a, "W11165528"), state(a, "W10006355")]).toEqual([null, "failed"]);
    expect([state(b, "W11165528"), state(b, "W10006355")]).toEqual(["pulled", null]);
    await setPartState(db, "901", "W11165528", null);
    await setPartState(db, "347", "W10006355", null);
  });

  it("3. an uncached readable model goes through the existing lookup once, then detail uses the saved BOM", async () => {
    await addMachine({ machineNo: "902", brand: "Maytag", model: "MEDC465HW0", serial: "DDD444" });

    expect(redirect).toHaveBeenCalledWith("/machines/902");
    expect(lookupModelBom).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lookupModelBom).mock.calls[0][0]).toEqual({ brand: "Maytag", model: "MEDC465HW0" });
    expect(supplierHttp.mock.calls.every(([u]) => String(u).startsWith("https://partstore.encompass.com/"))).toBe(true);

    const cache = await cacheRow("MAYTAG", "MEDC465HW0");
    expect(cache).toMatchObject({ status: "found", source: "encompass", brandDisplay: "Maytag", modelDisplay: "MEDC465HW0" });
    const edges = await edgesFor("MAYTAG", "MEDC465HW0");
    expect(edges.length).toBe(cache.rowCount);
    expect(edges.length).toBeGreaterThan(20);

    const d = await machineDetail(db, "902");
    expect(d?.bom).toEqual(cache);
    expect(d?.parts.map((p) => p.mpn_canonical).sort()).toEqual(edges.map((e) => e.mpnCanonical));

    // A second machine of that model (different serial) reuses the BOM just read.
    vi.mocked(lookupModelBom).mockClear();
    supplierHttp.mockClear();
    await addMachine({ machineNo: "903", brand: "Maytag", model: "MEDC465HW0", serial: "EEE555" });
    expect(lookupModelBom).not.toHaveBeenCalled();
    expect(supplierHttp).not.toHaveBeenCalled();
    expect(await cacheRow("MAYTAG", "MEDC465HW0")).toEqual(cache);
    expect((await machineDetail(db, "903"))?.parts.length).toBe(edges.length);
  });

  it.each(["not_found", "error"] as const)("4. supplier %s leaves the machine saved, exposes the status and creates no MPNs", async (status) => {
    supplier = status;
    const model = status === "error" ? "WTW4816FW2" : "WTW4950HW0";
    const mastersBefore = await db.$count(schema.mpnMaster);
    const machineNo = status === "error" ? "905" : "904";

    await addMachine({ machineNo, brand: "Whirlpool", model, serial: "FFF666" });

    expect(redirect).toHaveBeenCalledWith(`/machines/${machineNo}`);
    expect(lookupModelBom).toHaveBeenCalledTimes(1);
    const d = await machineDetail(db, machineNo);
    expect(d?.machine).toMatchObject({ machineNo, brandKey: "WHIRLPOOL", modelKey: model, identityStatus: "ok" });
    expect(d?.bom).toMatchObject({ status, rowCount: 0, source: null });
    expect(d?.parts).toEqual([]);
    expect(await edgesFor("WHIRLPOOL", model)).toEqual([]);
    expect(await db.$count(schema.mpnMaster)).toBe(mastersBefore);
    if (status === "error") {
      // Errors stay in the Parts lists queue for retry.
      const s = await getSettings(db);
      expect((await modelsNeedingBom(db, {}, s.donorAvailabilities)).map((m) => [m.model_key, m.bom_status])).toContainEqual([model, "error"]);
    }
  });

  it("5. needs_nameplate machines never trigger a BOM lookup", async () => {
    const cachesBefore = await db.$count(schema.modelBomCache);
    await addMachine({ machineNo: "906", brand: "GE", model: "NO NAMEPLATE" });

    expect(redirect).toHaveBeenCalledWith("/machines/906");
    expect(lookupModelBom).not.toHaveBeenCalled();
    expect(supplierHttp).not.toHaveBeenCalled();
    expect(await db.$count(schema.modelBomCache)).toBe(cachesBefore);
    const d = await machineDetail(db, "906");
    expect(d?.machine.identityStatus).toBe("needs_nameplate");
    expect(d?.bom).toBeUndefined();
  });

  it("6. bulk import never triggers supplier lookup; uncached models wait in the queue", async () => {
    const csv = [
      "ID,Brand,Model,Serial,Availability",
      "1001,Whirlpool,WTW5000DW1,,PARTS ONLY",
      "1002,Samsung,DV45H7000EW/A2,,UNCHECKED",
      "1003,Maytag,MVWX655DW1,GGG777,UNCHECKED"
    ].join("\n");
    const form = new FormData();
    form.set("file", new File([csv], "fleet.csv", { type: "text/csv" }));
    const cachesBefore = await db.$count(schema.modelBomCache);

    const res = await importFleetAction(null, form);

    expect(res).toMatchObject({ ok: true });
    expect(lookupModelBom).not.toHaveBeenCalled();
    expect(supplierHttp).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    expect(await db.$count(schema.modelBomCache)).toBe(cachesBefore);
    const s = await getSettings(db);
    const queued = (await modelsNeedingBom(db, {}, s.donorAvailabilities)).map((m) => m.model_key);
    expect(queued).toEqual(expect.arrayContaining(["WTW5000DW1", "DV45H7000EW/A2"]));
    expect(queued).not.toContain("MVWX655DW1");
  });

  it("7. reverse MPN -> machines lookup still lists every machine on that model", async () => {
    const d = await mpnDetail(db, "W11165528");
    expect(d?.machines.map((m) => m.machine_no).sort()).toEqual(["1003", "347", "901"]);
    expect(d?.models.map((m) => m.model_key)).toEqual(["MVWX655DW1"]);
  });

  it("8. market facts, Roadrunner sales history and greenlight inputs are unchanged", async () => {
    expect(await marketRows()).toEqual(before.market);
    expect(await salesRows()).toEqual(before.sales);
    // The uncached lookup legitimately added new MPNs; the ones that existed must not change.
    const known = new Set(before.master.map((m) => m.mpnCanonical));
    expect((await masterRows()).filter((m) => known.has(m.mpnCanonical))).toEqual(before.master);
    // New machines move donor counts; every market/verdict field must not.
    type Index = Awaited<ReturnType<typeof allIndex>>;
    const strip = (x: Index) => ({ settings: x.settings, rows: x.rows.filter((r) => known.has(r.mpn_canonical)).map(({ donors: _d, ...r }) => r) });
    expect(strip(await allIndex())).toEqual(strip(before.all));
    expect(strip(await greenIndex())).toEqual(strip(before.green));
    expect((await greenIndex()).rows.map((r) => [r.mpn_canonical, r.verdict])).toEqual([
      ["W11165528", expect.objectContaining({ verdict: "GREENLIGHT", profit: 45.75 })]
    ]);
  });

  it("the Parts lists API route still reads and saves through the same path", async () => {
    supplier = "not_found";
    const res = await bomRoute(new Request("http://local/api/bom/model", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand: "Whirlpool", model: "WTW5000DW1" })
    }));
    expect(await res.json()).toMatchObject({ status: "not_found", rows: 0, supplier: null });
    expect(lookupModelBom).toHaveBeenCalledTimes(1);
    expect(await cacheRow("WHIRLPOOL", "WTW5000DW1")).toMatchObject({ status: "not_found" });
  });
});
