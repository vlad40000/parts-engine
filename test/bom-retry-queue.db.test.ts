import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { bomQueue, getSettings, saveModelBom, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import type { ChainResult } from "@/src/sources/chain";
import BomPage from "@/app/bom/page";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

let db: Db;
let donors: string[];
const WASHER = "Washer - Top Load";
const filter = { availability: "PARTS ONLY" };
const errorModels = Array.from({ length: 304 }, (_, i) => `ERR${String(i + 1).padStart(4, "0")}`);
const machine = (ID: number, ModelNumber: string, Availability = "PARTS ONLY", SerialNumber = "") =>
  ({ ID, Availability, ApplianceType: WASHER, Brand: "Whirlpool", ModelNumber, SerialNumber });
const cache = (model: string, status: string) =>
  ({ brandKey: "WHIRLPOOL", modelKey: model, brandDisplay: "Whirlpool", modelDisplay: model, status });
const render = async (sp: Record<string, string> = {}) => load(renderToStaticMarkup(await BomPage({ searchParams: Promise.resolve(sp) })));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  donors = (await getSettings(db)).donorAvailabilities;
  await upsertFleet(db, mapRows());
  await db.insert(schema.modelBomCache).values([
    ...errorModels.map((m) => cache(m, "error")), cache("OFFONLY", "error"),
    cache("FOUND", "found"), cache("MISS", "not_found")
  ]);
});

function mapRows() {
  return mapFleetRows([
    ...errorModels.map((model, i) => machine(i + 1, model, "PARTS ONLY", i === 0 ? "CD2412345" : "")),
    machine(500, "ERR0001", "PARTS ONLY", "CD2412345"),
    machine(501, "FRESH01"), machine(502, "FRESH02"), machine(503, "FRESH02"), machine(504, "FRESH03"),
    machine(505, "FOUND"), machine(506, "MISS"),
    machine(600, "OFFONLY", "SOLD"), machine(601, "OFFONLY", "SCRAPED"), machine(602, "OFFONLY", "SCRAPPED")
  ]).rows;
}

describe("separate new and retry parts-list queues", () => {
  it("defaults to unattempted models and excludes errors from both rows and totals", async () => {
    const fresh = await bomQueue(db, filter, donors);
    expect(fresh).toMatchObject({ totalModels: 3, totalMachines: 4, categoryCounts: { new: 3, retry: 304 } });
    expect(fresh.rows.map((r) => r.model_key)).toEqual(["FRESH02", "FRESH01", "FRESH03"]);
    expect(fresh.rows.every((r) => r.bom_status === null)).toBe(true);
  });

  it("paginates retries independently, without fresh, completed or off-lot models", async () => {
    const f = { ...filter, queue: "retry" as const };
    const first = await bomQueue(db, f, donors);
    const second = await bomQueue(db, f, donors, 300, 300);
    expect(first).toMatchObject({ totalModels: 304, totalMachines: 305, offset: 0 });
    expect(first.rows).toHaveLength(300);
    expect(second).toMatchObject({ totalModels: 304, totalMachines: 305, offset: 300 });
    expect([...first.rows, ...second.rows].map((r) => r.model_key)).toEqual(errorModels);
    expect(first.rows.every((r) => r.bom_status === "error")).toBe(true);
    expect(await bomQueue(db, f, donors, 300, 900)).toEqual(second);
  });

  it("applies status, age, type and brand filters to both categories and their counts", async () => {
    const aged = await bomQueue(db, { ...filter, queue: "retry", band: "2020+", brand: "WHIRLPOOL", type: WASHER }, donors);
    expect(aged).toMatchObject({ totalModels: 1, totalMachines: 2, categoryCounts: { new: 0, retry: 1 } });
    expect(aged.rows.map((r) => r.model_key)).toEqual(["ERR0001"]);
    for (const availability of [undefined, "SOLD", "SCRAPED", "SCRAPPED"]) {
      expect(await bomQueue(db, { availability, queue: "retry" }, [...donors, "SOLD", "SCRAPED", "SCRAPPED"]))
        .toMatchObject({ rows: [], totalModels: 0, totalMachines: 0, categoryCounts: { new: 0, retry: 0 } });
    }
  });

  it("shows category counts, defaults to new lookups and resets pagination when switching", async () => {
    const $ = await render({ ...filter, offset: "300" });
    expect($("tbody tr").map((_, tr) => $(tr).find("td").eq(2).text()).get()).toEqual(["FRESH02", "FRESH01", "FRESH03"]);
    expect($('nav[aria-label="Lookup category"] a[aria-current="page"]').text()).toBe("New lookups (3)");
    expect($('nav[aria-label="Lookup category"] a').last().attr("href")).toBe("?availability=PARTS+ONLY&queue=retry");
    expect($('nav[aria-label="Lookup category"] a').last().text()).toBe("Retries (304)");
  });

  it("preserves the retry category and all filters through pagination and form submission", async () => {
    const $ = await render({ ...filter, queue: "retry", band: "unknown", type: WASHER, brand: "WHIRLPOOL" });
    expect($('input[type="hidden"][name="queue"]').attr("value")).toBe("retry");
    expect($('a').filter((_, a) => $(a).text() === "Next →").attr("href"))
      .toBe("?band=unknown&type=Washer+-+Top+Load&brand=WHIRLPOOL&availability=PARTS+ONLY&queue=retry&offset=300");
    expect($('nav[aria-label="Lookup category"] a[aria-current="page"]').text()).toBe("Retries (303)");
    expect($("h2").first().text()).toBe("Models to retry");
    expect($("tbody input[type=checkbox]")).toHaveLength(300);
  });

  it("shows an accurate empty retry state and treats an unknown category as new lookups", async () => {
    const empty = await render({ ...filter, queue: "retry", brand: "MAYTAG" });
    expect(empty("tbody").text()).toContain("No models need a retry in this filter.");
    const unknown = await render({ ...filter, queue: "something-else" });
    expect(unknown('nav[aria-label="Lookup category"] a[aria-current="page"]').text()).toBe("New lookups (3)");
  });

  it("moves a failed new lookup into retries, then removes a successful retry from both", async () => {
    const error: ChainResult = { status: "error", winner: null, attempts: [] };
    const save = (model: string, result: ChainResult) => saveModelBom(db, { ...cache(model, result.status), result });
    await save("FRESH01", error);
    expect(await bomQueue(db, filter, donors)).toMatchObject({ totalModels: 2, totalMachines: 3, categoryCounts: { new: 2, retry: 305 } });
    expect((await bomQueue(db, { ...filter, queue: "retry" }, donors, 1000)).rows.map((r) => r.model_key)).toContain("FRESH01");
    const winner = {
      supplier: "encompass", status: "found" as const, droppedRows: 0, sourceUrl: "https://example.test/model", visited: [], warnings: [], elapsedMs: 1,
      rows: [{ mpnDisplay: "W11165528", mpnCanonical: "W11165528", description: "Control Board", diagramId: "1", supplierPartId: null, newPrice: 80, nla: false }]
    };
    await save("FRESH01", { status: "found", winner, attempts: [winner] });
    expect(await bomQueue(db, filter, donors)).toMatchObject({ totalModels: 2, categoryCounts: { new: 2, retry: 304 } });
    expect((await bomQueue(db, { ...filter, queue: "retry" }, donors, 1000)).rows.map((r) => r.model_key)).not.toContain("FRESH01");
    expect(await db.$count(schema.modelPartEdges)).toBe(1);
  });
});
