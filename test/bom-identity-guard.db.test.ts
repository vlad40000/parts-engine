import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { bomQueue, getSettings, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { readModelBom } from "@/src/lib/model-bom";
import type { Fetcher } from "@/src/sources/types";
import BomPage from "@/app/bom/page";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const fx = (p: string) => readFileSync(path.join(__dirname, "fixtures", p), "utf8");
const MAYTAG_PAGE = "https://www.appliancepartspros.com/parts-for-maytag-mvwx655dw1.html";
const REFUSAL = `appliancepartspros: AppliancePartsPros returned ${MAYTAG_PAGE}, which is not Frigidaire FFTW4120SW1; nothing was read from it.`;

/** Encompass has no page; the AppliancePartsPros search lands on Maytag MVWX655DW1 whatever was asked. */
const redirecting: Fetcher = async (url) => {
  if (url.includes("encompass")) return { ok: true, status: 200, finalUrl: url, html: "does not exist in our database" };
  if (url.includes("search.aspx")) return { ok: true, status: 200, finalUrl: MAYTAG_PAGE, html: fx("app/MVWX655DW1-model.html") };
  return { ok: true, status: 200, finalUrl: url, html: fx("app/MVWX655DW1-top.html") };
};

let db: Db;
let donors: string[];
const filter = { availability: "PARTS ONLY" };
const cacheRow = async (brandKey: string, modelKey: string) =>
  (await db.select().from(schema.modelBomCache)
    .where(and(eq(schema.modelBomCache.brandKey, brandKey), eq(schema.modelBomCache.modelKey, modelKey))))[0];
const edgeCount = (brandKey: string, modelKey: string) =>
  db.$count(schema.modelPartEdges, and(eq(schema.modelPartEdges.brandKey, brandKey), eq(schema.modelPartEdges.modelKey, modelKey)));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  donors = (await getSettings(db)).donorAvailabilities;
  await upsertFleet(db, mapFleetRows([
    { ID: 1, Availability: "PARTS ONLY", ApplianceType: "Washer - Top Load", Brand: "Frigidaire", ModelNumber: "FFTW4120SW1", SerialNumber: "" },
    { ID: 2, Availability: "PARTS ONLY", ApplianceType: "Washer - Top Load", Brand: "Maytag", ModelNumber: "MVWX655DW1", SerialNumber: "" },
    { ID: 3, Availability: "PARTS ONLY", ApplianceType: "Washer - Top Load", Brand: "Whirlpool", ModelNumber: "MVWX655DW1", SerialNumber: "" }
  ]).rows);
});

describe("a supplier page for another model is never saved", () => {
  it("records the rejected landing page and writes no parts, MPNs or aliases", async () => {
    const { result, saved } = await readModelBom(db, { brand: "Frigidaire", model: "FFTW4120SW1" }, redirecting);
    expect(result).toMatchObject({ status: "error", winner: null });
    expect(saved).toEqual({ rows: 0, newMpns: 0 });
    const cache = await cacheRow("FRIGIDAIRE", "FFTW4120SW1");
    expect(cache).toMatchObject({ status: "error", source: null, sourceUrl: null, rowCount: 0 });
    // The evidence stays reviewable: which page the supplier offered and why it was refused.
    expect(cache.warnings).toContain(REFUSAL);
    expect(await edgeCount("FRIGIDAIRE", "FFTW4120SW1")).toBe(0);
    expect(await db.$count(schema.mpnMaster)).toBe(0);
    expect(await db.$count(schema.mpnAlias)).toBe(0);
  });

  it("keeps the refused model in Retries with the refusal, never closed as not found", async () => {
    const retry = await bomQueue(db, { ...filter, queue: "retry" }, donors);
    expect(retry.rows).toEqual([expect.objectContaining({ model_key: "FFTW4120SW1", bom_status: "error", identity_refusal: REFUSAL.replace("appliancepartspros: ", "") })]);
    const fresh = await bomQueue(db, filter, donors);
    expect(fresh.rows.map((r) => [r.brand_key, r.model_key])).toEqual([["MAYTAG", "MVWX655DW1"], ["WHIRLPOOL", "MVWX655DW1"]]);
    expect(fresh.rows.every((r) => r.identity_refusal === null)).toBe(true);

    const $ = load(renderToStaticMarkup(await BomPage({ searchParams: Promise.resolve({ ...filter, queue: "retry" }) })));
    const cell = $("tbody tr").first().find("td").eq(2);
    expect(cell.find(".pill").text()).toBe("identity mismatch");
    expect(cell.text()).toContain(`AppliancePartsPros returned ${MAYTAG_PAGE}, which is not Frigidaire FFTW4120SW1`);
    expect(cell.text()).toContain("Check the nameplate");
  });

  it("saves nothing from an incomplete catalog and keeps the model in Retries", async () => {
    // Whirlpool files this Maytag page (same manufacturer), but one section is blocked.
    const blocked: Fetcher = async (url) =>
      url.includes("top-and-cabinet") ? { ok: false, status: 403, finalUrl: url, html: "" } : redirecting(url);
    const { result, saved } = await readModelBom(db, { brand: "Whirlpool", model: "MVWX655DW1" }, blocked);
    expect(result).toMatchObject({ status: "error", winner: null });
    expect(saved).toEqual({ rows: 0, newMpns: 0 });
    expect(await cacheRow("WHIRLPOOL", "MVWX655DW1")).toMatchObject({ status: "error", source: null, rowCount: 0 });
    expect(await edgeCount("WHIRLPOOL", "MVWX655DW1")).toBe(0);
    expect(await db.$count(schema.mpnMaster)).toBe(0);
    const retry = await bomQueue(db, { ...filter, queue: "retry" }, donors);
    expect(retry.rows.find((r) => r.brand_key === "WHIRLPOOL")).toMatchObject({ bom_status: "error", identity_refusal: null });
  });

  it("still saves the page's own model", async () => {
    const { result, saved } = await readModelBom(db, { brand: "Maytag", model: "MVWX655DW1" }, redirecting);
    expect(result.status).toBe("found");
    expect(result.winner?.sourceUrl).toBe(MAYTAG_PAGE);
    expect(saved.rows).toBeGreaterThan(5);
    expect(await edgeCount("MAYTAG", "MVWX655DW1")).toBe(saved.rows);
    expect(await edgeCount("FRIGIDAIRE", "FFTW4120SW1")).toBe(0);
  });
});
