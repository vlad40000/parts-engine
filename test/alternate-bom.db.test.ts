import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import type { Fetcher } from "@/src/sources/types";
import { getSettings, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { GET, POST } from "@/app/api/bom/model/route";
import { BatchRunner } from "@/src/components/batch-runner";
import { catalogFetcher } from "./catalog-fixture";
const holder = vi.hoisted(() => ({ db: null as unknown, dbCalls: 0, supplierCalls: 0, fetcher: null as unknown as Fetcher }));
vi.mock("@/src/db", () => ({ getDb: async () => { holder.dbCalls++; return holder.db; }, hasDatabase: () => { holder.dbCalls++; return true; } }));
vi.mock("@/src/lib/model-bom", async (original) => ({ ...await original<object>(), supplierFetcher: async (url: string) => { holder.supplierCalls++; return holder.fetcher(url); } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
let client: PGlite, db: Db;
const ge = { brand: "GE", model: "GSD3460G00SS", availability: "PARTS ONLY" };
const samsung = { brand: "Samsung", model: "DV45H7000EW/A2", availability: "UNCHECKED" };
const post = (body: object) => POST(new Request("http://local/api/bom/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const get = (body: Record<string, string>) => GET(new Request("http://local/api/bom/model?" + new URLSearchParams(body)));
const snapshot = async () => {
  const names = await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' order by tablename");
  const result: Record<string, string[]> = {};
  for (const { tablename } of names.rows) result[tablename] = (await client.query(`select row_to_json(t)::text as row from "${tablename}" t`)).rows.map((r) => (r as { row: string }).row).sort();
  return result;
};
beforeAll(async () => {
  client = new PGlite(); db = drizzle(client, { schema }) as unknown as Db; holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await getSettings(db);
  await upsertFleet(db, mapFleetRows([
    { ID: 1, Brand: ge.brand, ModelNumber: ge.model, Availability: ge.availability, ApplianceType: "Dishwasher" },
    { ID: 2, Brand: samsung.brand, ModelNumber: samsung.model, Availability: samsung.availability, ApplianceType: "Dryer" },
    { ID: 3, Brand: "GE", ModelNumber: "OFFLOT1", Availability: "SOLD", ApplianceType: "Dishwasher" }
  ]).rows);
});
beforeEach(() => { holder.dbCalls = 0; holder.supplierCalls = 0; holder.fetcher = catalogFetcher().fetcher; });
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => client.close());

describe("alternate source API and persistence on a disposable database", () => {
  it("saves an explicit Parts Dr catalog through the existing OEM/provenance path", async () => {
    const response = await post({ ...samsung, source: "partsdr" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "found", supplier: "partsdr", rows: 73 });
    const cache = (await db.select().from(schema.modelBomCache))[0];
    expect(cache).toMatchObject({ source: "partsdr", rowCount: 73, status: "found" });
    expect(cache.attempts).toMatchObject([{ supplier: "partsdr", completeness: "complete", catalogPages: 2, catalogRows: 73 }]);
    const edges = await db.select().from(schema.modelPartEdges);
    expect(edges).toHaveLength(73);
    expect(edges.every((e) => e.source === "partsdr" && e.modelKey === "DV45H7000EW/A2")).toBe(true);
    expect(edges.find((e) => e.mpnCanonical === "DC6301026A")).toMatchObject({ newPrice: null, nla: false });
  });
  it("a failed alternate does not overwrite a verified cache, OEMs or edges", async () => {
    const before = await snapshot();
    holder.fetcher = async (url) => ({ ok: false, status: 403, finalUrl: url, html: "" });
    expect(await (await post({ ...samsung, source: "partselect" })).json()).toMatchObject({ status: "error", rows: 0 });
    expect(await snapshot()).toEqual(before);
  });
  it("a selected-source miss on an unverified model stays available for another retry", async () => {
    holder.fetcher = async (url) => ({ ok: false, status: 404, finalUrl: url, html: "" });
    expect(await (await post({ ...ge, source: "partselect" })).json()).toMatchObject({ status: "error", rows: 0 });
    expect((await db.select().from(schema.modelBomCache)).find((c) => c.modelKey === ge.model)).toMatchObject({ status: "error", rowCount: 0 });
  });
  it("saves PartSelect OEMs, not PS retailer IDs, and records the selected supplier", async () => {
    expect(await (await post({ ...ge, source: "partselect" })).json()).toMatchObject({ status: "found", supplier: "partselect", rows: 126 });
    const edges = (await db.select().from(schema.modelPartEdges)).filter((e) => e.modelKey === ge.model);
    expect(edges).toHaveLength(126);
    expect(edges.every((e) => e.source === "partselect" && !/^PS\d+$/.test(e.mpnCanonical))).toBe(true);
    expect(edges.find((e) => e.mpnCanonical === "WD35X21038")).toMatchObject({ supplierPartId: "PS11726733" });
  });
  it("rejects invalid source, unreadable identity, unselected status, absent and off-lot donors before supplier work", async () => {
    const before = await snapshot();
    for (const body of [{ ...ge, source: "other" }, { ...ge, model: "NO NAMEPLATE", source: "partsdr" }, { ...ge, availability: "", source: "partsdr" }, { ...ge, model: "ABSENT1", source: "partsdr" }, { ...ge, model: "OFFLOT1", availability: "SOLD", source: "partsdr" }]) {
      expect((await post(body)).status).toBeGreaterThanOrEqual(400);
      expect((await get(body)).status).toBeGreaterThanOrEqual(400);
    }
    expect(holder.supplierCalls).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
  it("Preview POST rejects before database access even when called directly", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await post({ ...ge, source: "partsdr" })).status).toBe(403);
    expect(holder.dbCalls).toBe(0);
    expect(holder.supplierCalls).toBe(0);
  });
  it("Preview GET exercises both real adapters with no changes to any public table", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const before = await snapshot();
    for (const source of ["partsdr", "partselect"]) {
      const response = await get({ ...ge, source });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ readOnly: true, status: "found", supplier: source, rows: 126 });
    }
    expect(holder.supplierCalls).toBeGreaterThan(15);
    expect(await snapshot()).toEqual(before);
  });
  it("the source-check GET never initializes a missing settings row", async () => {
    await db.delete(schema.settings);
    const before = await snapshot();
    expect((await get({ ...ge, source: "partsdr" })).status).toBe(409);
    expect(holder.supplierCalls).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});

it("shows a skip-Encompass default only in Retries, with Preview saving disabled", () => {
  const render = (category: "new" | "retry", readOnly = false) => load(renderToStaticMarkup(createElement(BatchRunner, { candidates: [], batchSize: 10, category, readOnly })));
  expect(render("new")('select')).toHaveLength(0);
  const retry = render("retry");
  expect(retry('label').text()).toContain("Retry using");
  expect(retry('option[selected]').attr('value')).toBe('alternatives');
  expect(retry('option').map((_, e) => retry(e).attr('value')).get()).toEqual(['alternatives', 'partsdr', 'partselect', 'auto']);
  expect(render("retry", true).text()).toContain("Saving parts lists is disabled on Preview");
  expect(render("retry", true)('button').filter((_, e) => /Run/.test(retry(e).text())).attr('disabled')).toBeDefined();
});
