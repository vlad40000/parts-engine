import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  BOM_QUEUE_PAGE_SIZE, bomQueue, getSettings, modelsNeedingBom, saveModelBom, saveSettings, upsertFleet,
  type FleetFilter, type ModelCandidate
} from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { selectionOnPage, type Candidate } from "@/src/components/batch-runner";
import BomPage from "@/app/bom/page";

// The Parts lists page renders against this file's PGlite database.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

let db: Db;
let donors: string[];
const NOW = new Date("2026-10-06T12:00:00Z");
const WASHER = "Washer - Top Load";
const DRYER = "Dryer - Electric";
const PAGE = BOM_QUEUE_PAGE_SIZE;
// Every pending Brand + Model group in the fleet below, and the donor machines they hold.
const TOTAL = { totalModels: 328, totalMachines: 340 };

const pad = (n: number) => String(n).padStart(4, "0");
const seq = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const washer = (ID: number, ModelNumber: string, Availability = "UNCHECKED", SerialNumber = "") =>
  ({ ID, Availability, ApplianceType: WASHER, Brand: "Whirlpool", ModelNumber, SerialNumber });
const dryer = (ID: number, ModelNumber: string) =>
  ({ ID, Availability: "UNCHECKED", ApplianceType: DRYER, Brand: "Maytag", ModelNumber, SerialNumber: "" });
const machinesIn = (rows: ModelCandidate[]) => rows.reduce((n, r) => n + r.machines, 0);
const wholeQueue = (f: FleetFilter = {}) => modelsNeedingBom(db, f, donors, 100000);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  donors = (await getSettings(db)).donorAvailabilities;

  await upsertFleet(db, mapFleetRows([
    // 4 donor machines (one serial allows 1994 or 2024); the READY TO SALE unit is not a donor.
    washer(1001, "WTWBIG1", "UNCHECKED", "CD2412345"), washer(1002, "WTWBIG1"), washer(1003, "WTWBIG1", "PARTS ONLY"),
    washer(1004, "WTWBIG1", "NEEDS PARTS"), washer(1005, "WTWBIG1", "READY TO SALE"),
    // 3 donor machines built in 2007.
    ...seq(1011, 1013).map((id) => washer(id, "WTWBIG2", "PARTS PROGRAM", "SU1727374")),
    ...seq(4001, 4005).map((id) => washer(id, "WTWFOUND")),
    ...seq(4011, 4012).map((id) => washer(id, "WTWNF")),
    ...seq(4021, 4022).map((id) => washer(id, "WTWERR")),
    // 310 single-machine washer models push the queue past one 300-row page.
    ...seq(1, 310).map((n) => washer(2000 + n, `WTW${pad(n)}`)),
    ...seq(3001, 3002).map((id) => dryer(id, "MEDBIG")),
    ...seq(1, 12).map((n) => dryer(3100 + n, `MED${pad(n)}`)),
    // Never queued: a model whose only machines are not donors, and an unreadable model.
    washer(5001, "WTWOFF", "READY TO SALE"), washer(5002, "WTWOFF", "READY TO SALE"),
    { ID: 5101, Availability: "UNCHECKED", ApplianceType: "Range", Brand: "GE", ModelNumber: "NO NAMEPLATE" }
  ], NOW).rows);
  // identity 'ok' with an empty model key is still not a parts-list identity.
  await db.insert(schema.fleetMachines).values({ machineNo: "5201", brand: "Whirlpool", brandKey: "WHIRLPOOL", identityStatus: "ok" });
});

describe("pending parts-list queue: totals and paging", () => {
  it("page 1 reports every pending group and donor machine but holds only one bounded page", async () => {
    expect(PAGE).toBe(300);
    const page1 = await bomQueue(db, {}, donors);
    expect(page1).toMatchObject({ ...TOTAL, offset: 0 });
    expect(page1.rows).toHaveLength(PAGE);
    // Most donor machines first, then brand_key, then model_key.
    expect(page1.rows.slice(0, 8).map((r) => [r.brand_key, r.model_key, r.machines])).toEqual([
      ["WHIRLPOOL", "WTWFOUND", 5], ["WHIRLPOOL", "WTWBIG1", 4], ["WHIRLPOOL", "WTWBIG2", 3],
      ["MAYTAG", "MEDBIG", 2], ["WHIRLPOOL", "WTWERR", 2], ["WHIRLPOOL", "WTWNF", 2],
      ["MAYTAG", "MED0001", 1], ["MAYTAG", "MED0002", 1]
    ]);
    expect(page1.rows.at(-1)?.model_key).toBe("WTW0282");
    // The visible page alone undercounts the workload.
    expect(machinesIn(page1.rows)).toBe(312);
  });

  it("Next returns the following ordered rows and Prev returns page 1", async () => {
    const page1 = await bomQueue(db, {}, donors);
    const page2 = await bomQueue(db, {}, donors, PAGE, page1.offset + PAGE);
    expect(page2).toMatchObject({ ...TOTAL, offset: 300 });
    expect(page2.rows.map((r) => r.model_key)).toEqual(seq(283, 310).map((n) => `WTW${pad(n)}`));
    // Together the pages are the whole ordered queue: no gap, no overlap.
    const whole = await wholeQueue();
    expect([...page1.rows, ...page2.rows]).toEqual(whole);
    // The machine total is the sum over every pending group, not over the visible page.
    expect(machinesIn(whole)).toBe(TOTAL.totalMachines);
    expect(await bomQueue(db, {}, donors, PAGE, page2.offset - PAGE)).toEqual(page1);
  });

  it("filters keep the totals and the paging inside the filtered set", async () => {
    // Whirlpool machines with no decodable serial: WTWBIG2 drops out and WTWBIG1 keeps 3 of its 4 donors.
    const f = { brand: "WHIRLPOOL", band: "unknown" };
    const first = await bomQueue(db, f, donors);
    const second = await bomQueue(db, f, donors, PAGE, PAGE);
    expect(first).toMatchObject({ totalModels: 314, totalMachines: 322, offset: 0 });
    expect(second).toMatchObject({ totalModels: 314, totalMachines: 322, offset: 300 });
    expect(first.rows).toHaveLength(PAGE);
    expect(first.rows.find((r) => r.model_key === "WTWBIG1")?.machines).toBe(3);
    expect(second.rows.map((r) => r.model_key)).toEqual(seq(297, 310).map((n) => `WTW${pad(n)}`));
    const filtered = await wholeQueue(f);
    expect([...first.rows, ...second.rows]).toEqual(filtered);
    expect(filtered.every((r) => r.brand_key === "WHIRLPOOL")).toBe(true);

    expect(await bomQueue(db, { type: DRYER }, donors)).toMatchObject({ totalModels: 13, totalMachines: 14, offset: 0 });
    // A band means "any possible year": the 1994-or-2024 serial counts in both bands.
    for (const band of ["2020+", "pre-2005"]) {
      const q = await bomQueue(db, { band }, donors);
      expect(q).toMatchObject({ totalModels: 1, totalMachines: 1 });
      expect(q.rows.map((r) => [r.model_key, r.machines])).toEqual([["WTWBIG1", 1]]);
    }
    expect(await bomQueue(db, { band: "2005-2009" }, donors)).toMatchObject({ totalModels: 1, totalMachines: 3 });
  });

  it("Settings donor statuses and the identity rules still decide which machines are queued", async () => {
    const whole = await wholeQueue();
    expect(whole.map((r) => r.model_key)).not.toContain("WTWOFF");
    expect(whole.map((r) => r.model_key)).not.toContain("");
    expect(whole.some((r) => r.brand_key === "GE")).toBe(false);
    // The READY TO SALE unit of WTWBIG1 is not counted.
    expect(whole.find((r) => r.model_key === "WTWBIG1")?.machines).toBe(4);
    // The donor set is authoritative: READY TO SALE as a donor status adds WTWOFF (2 machines) and unit 1005.
    expect(await bomQueue(db, {}, [...donors, "READY TO SALE"])).toMatchObject({ totalModels: 329, totalMachines: 343 });
    expect(await bomQueue(db, {}, [])).toMatchObject({ rows: [], totalModels: 0, totalMachines: 0, offset: 0 });
  });

  it("an offset past the end (the queue shrank under the page) falls back to the last page", async () => {
    const stale = await bomQueue(db, {}, donors, PAGE, 900);
    expect(stale).toMatchObject({ ...TOTAL, offset: 300 });
    expect(stale.rows).toHaveLength(28);
    expect(await bomQueue(db, { type: DRYER }, donors, PAGE, 300)).toMatchObject({ totalModels: 13, offset: 0 });
    expect((await bomQueue(db, {}, donors, PAGE, -20)).offset).toBe(0);
    expect(await bomQueue(db, { band: "2010-2014" }, donors, PAGE, 300)).toMatchObject({ rows: [], totalModels: 0, totalMachines: 0, offset: 0 });
  });
});

describe("Parts lists page", () => {
  const render = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await BomPage({ searchParams: Promise.resolve(sp) }));
  const textOf = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  const queueRows = (html: string) => html.match(/type="checkbox"/g)?.length ?? 0;
  const pager = (html: string) => [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>(← Prev|Next →)<\/a>/g)].map((m) => [m[2], m[1].replace(/&amp;/g, "&")]);

  it("page 1 shows the full pending totals, says it is a grouped queue, and offers Next", async () => {
    const html = await render();
    const text = textOf(html);
    expect(text).toContain("328 Brand + Model groups need a parts list · 340 donor machines in those groups");
    expect(text).toContain("grouped parts-list (BOM) queue, not the full Fleet");
    expect(text).toContain("donor status in Settings (UNCHECKED, PARTS ONLY, NEEDS PARTS, PARTS PROGRAM).");
    expect(text).toContain("1–300 of 328");
    expect(queueRows(html)).toBe(300);
    expect(pager(html)).toEqual([["Next →", "?offset=300"]]);
  });

  it("page 2 shows the remaining rows under the same totals, with Prev", async () => {
    const html = await render({ offset: "300" });
    expect(textOf(html)).toContain("328 Brand + Model groups need a parts list · 340 donor machines in those groups");
    expect(textOf(html)).toContain("301–328 of 328");
    expect(queueRows(html)).toBe(28);
    expect(pager(html)).toEqual([["← Prev", "?"]]);
  });

  it("paging links keep the filters, and the totals are for the filtered set", async () => {
    const html = await render({ brand: "WHIRLPOOL", band: "unknown" });
    expect(textOf(html)).toContain("314 Brand + Model groups need a parts list · 322 donor machines in those groups");
    expect(textOf(html)).toContain("PARTS PROGRAM) and that match the filters above.");
    expect(pager(html)).toEqual([["Next →", "?band=unknown&brand=WHIRLPOOL&offset=300"]]);

    const next = await render({ brand: "WHIRLPOOL", band: "unknown", offset: "300" });
    expect(textOf(next)).toContain("301–314 of 314");
    expect(queueRows(next)).toBe(14);
    expect(pager(next)).toEqual([["← Prev", "?band=unknown&brand=WHIRLPOOL"]]);
  });

  it("a queue that fits on one page says so and shows no pager", async () => {
    const html = await render({ type: DRYER });
    expect(textOf(html)).toContain("13 Brand + Model groups need a parts list · 14 donor machines in those groups");
    expect(textOf(html)).toContain("All 13 groups are on this page.");
    expect(queueRows(html)).toBe(13);
    expect(pager(html)).toEqual([]);
  });

  it("a stale page past the end shows the last page instead of an empty queue", async () => {
    const html = await render({ offset: "900" });
    expect(textOf(html)).toContain("301–328 of 328");
    expect(textOf(html)).not.toContain("Every donor model in this filter has a parts list.");
    expect(queueRows(html)).toBe(28);
  });

  it("totals follow the Settings donor statuses", async () => {
    const s = await getSettings(db);
    await saveSettings(db, { ...s, donorAvailabilities: [...s.donorAvailabilities, "READY TO SALE"] });
    try {
      expect(textOf(await render())).toContain("329 Brand + Model groups need a parts list · 343 donor machines in those groups");
    } finally {
      await saveSettings(db, s);
    }
  });
});

describe("batch selection across pages", () => {
  const c = (model: string): Candidate => ({ brand_key: "WHIRLPOOL", model_key: model, brand: "Whirlpool", model, machines: 1, types: WASHER, bom_status: null });

  it("keeps only the selections that are rows on the current page", () => {
    const selected = new Set(["WHIRLPOOL::WTW0001", "WHIRLPOOL::WTW0002"]);
    expect(selectionOnPage(selected, [c("WTW0001"), c("WTW0002"), c("WTW0003")])).toBe(selected);
    expect([...selectionOnPage(selected, [c("WTW0002"), c("WTW0301")])]).toEqual(["WHIRLPOOL::WTW0002"]);
    expect(selectionOnPage(selected, [c("WTW0301")]).size).toBe(0);
  });
});

describe("parts-list status moves models out of the pending totals", () => {
  const part = (mpn: string, description: string): SupplierRow => ({
    mpnDisplay: mpn, mpnCanonical: mpn, description, diagramId: "1", supplierPartId: null, newPrice: 80, nla: false
  });
  const found = (rows: SupplierRow[]): ChainResult => ({
    status: "found",
    winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
    attempts: [{ supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 }]
  });
  const miss = (status: "not_found" | "error"): ChainResult => ({
    status, winner: null, attempts: [{ supplier: "encompass", status, droppedRows: 0, sourceUrl: null, visited: [], warnings: [], elapsedMs: 1 }]
  });
  const save = (model: string, result: ChainResult) =>
    saveModelBom(db, { brandKey: "WHIRLPOOL", modelKey: model, brandDisplay: "Whirlpool", modelDisplay: model, result });

  it("found and not_found leave the pending totals; error stays queued for retry", async () => {
    expect(await bomQueue(db, {}, donors)).toMatchObject(TOTAL);

    await save("WTWFOUND", found([part("W11165528", "Washer Electronic Control Board")]));
    expect(await bomQueue(db, {}, donors)).toMatchObject({ totalModels: 327, totalMachines: 335 });

    await save("WTWNF", miss("not_found"));
    expect(await bomQueue(db, {}, donors)).toMatchObject({ totalModels: 326, totalMachines: 333 });

    await save("WTWERR", miss("error"));
    const afterError = await bomQueue(db, {}, donors);
    expect(afterError).toMatchObject({ totalModels: 326, totalMachines: 333 });
    expect(afterError.rows.find((r) => r.model_key === "WTWERR")).toMatchObject({ machines: 2, bom_status: "error" });

    const keys = (await wholeQueue()).map((r) => r.model_key);
    expect(keys).not.toContain("WTWFOUND");
    expect(keys).not.toContain("WTWNF");
  });
});
