import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, asc, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { bomQueue, getSettings, saveModelBom, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { readModelBom } from "@/src/lib/model-bom";
import type { Fetcher } from "@/src/sources/types";

const fx = (p: string) => readFileSync(path.join(__dirname, "fixtures", p), "utf8");
const MAYTAG_PAGE = "https://www.appliancepartspros.com/parts-for-maytag-mvwx655dw1.html";
const page = (url: string, html: string, finalUrl = url) => ({ ok: true, status: 200, finalUrl, html });
const notListed = (url: string) => page(url, "does not exist in our database");

/** Encompass has no page; AppliancePartsPros serves the Maytag MVWX655DW1 catalog. */
const verified: Fetcher = async (url) =>
  url.includes("encompass") ? notListed(url)
    : url.includes("search.aspx") ? page(url, fx("app/MVWX655DW1-model.html"), MAYTAG_PAGE)
      : page(url, fx("app/MVWX655DW1-top.html"));

/** Later lookups of the same, already verified model that do not produce a winner. */
const FAILED: Record<string, { fetcher: Fetcher; status: string }> = {
  "every supplier answers HTTP 403": { status: "error", fetcher: async (url) => ({ ok: false, status: 403, finalUrl: url, html: "" }) },
  "every supplier answers HTTP 404": { status: "not_found", fetcher: async (url) => ({ ok: false, status: 404, finalUrl: url, html: "" }) },
  "the search now lands on another model": {
    status: "error",
    fetcher: async (url) => url.includes("search.aspx")
      ? page(url, fx("app/MVWX655DW1-model.html"), MAYTAG_PAGE.replace("mvwx655dw1", "mvwx655dw2")) : verified(url)
  },
  "one section is blocked": {
    status: "error",
    fetcher: async (url) => url.includes("top-and-cabinet") ? { ok: false, status: 403, finalUrl: url, html: "" } : verified(url)
  },
  "a supplier throws": { status: "error", fetcher: async (url) => { if (url.includes("search.aspx")) throw new Error("socket hang up"); return verified(url); } }
};

let db: Db;
let donors: string[];
const MAYTAG = { brandKey: "MAYTAG", modelKey: "MVWX655DW1" };
const snapshot = async () => ({
  cache: await db.select().from(schema.modelBomCache)
    .where(and(eq(schema.modelBomCache.brandKey, MAYTAG.brandKey), eq(schema.modelBomCache.modelKey, MAYTAG.modelKey))),
  edges: await db.select().from(schema.modelPartEdges).orderBy(asc(schema.modelPartEdges.mpnCanonical)),
  mpns: await db.select().from(schema.mpnMaster).orderBy(asc(schema.mpnMaster.mpnCanonical)),
  aliases: await db.select().from(schema.mpnAlias).orderBy(asc(schema.mpnAlias.aliasCanonical))
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  donors = (await getSettings(db)).donorAvailabilities;
  await upsertFleet(db, mapFleetRows([
    { ID: 1, Availability: "PARTS ONLY", ApplianceType: "Washer - Top Load", Brand: "Maytag", ModelNumber: "MVWX655DW1", SerialNumber: "" },
    { ID: 2, Availability: "PARTS ONLY", ApplianceType: "Washer - Top Load", Brand: "Frigidaire", ModelNumber: "FFTW4120SW1", SerialNumber: "" }
  ]).rows);
});

afterEach(() => vi.restoreAllMocks());

describe("a failed lookup never replaces a verified parts list", () => {
  it("starts from a verified BOM", async () => {
    const { result, saved } = await readModelBom(db, { brand: "Maytag", model: "MVWX655DW1" }, verified);
    expect(result.status).toBe("found");
    expect(saved.rows).toBeGreaterThan(5);
    expect(saved.kept).toBeUndefined();
  });

  for (const [scenario, { fetcher, status }] of Object.entries(FAILED)) {
    it(`keeps status, source, evidence, edges and MPNs when ${scenario}`, async () => {
      const before = await snapshot();
      expect(before.cache[0]).toMatchObject({ status: "found", source: "appliancepartspros", sourceUrl: MAYTAG_PAGE });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { result, saved } = await readModelBom(db, { brand: "Maytag", model: "MVWX655DW1" }, fetcher);
      expect(result).toMatchObject({ status, winner: null });
      expect(saved).toEqual({ rows: 0, newMpns: 0, kept: { rowCount: before.cache[0].rowCount, fetchedAt: before.cache[0].fetchedAt } });
      expect(await snapshot()).toEqual(before);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Parts list lookup for Maytag MVWX655DW1 ended ${status}; the verified list from`));

      // Still a found model: it neither re-enters New lookups nor appears in Retries.
      for (const queue of [undefined, "retry" as const]) {
        const q = await bomQueue(db, { availability: "PARTS ONLY", queue }, donors);
        expect(q.rows.some((r) => r.brand_key === "MAYTAG")).toBe(false);
      }
    });
  }

  it("still replaces a found BOM when a later lookup has a winner", async () => {
    const rows = ["W10000001", "W10000002", "W10000003", "W10000004", "W10000005"].map((mpn) => ({
      mpnDisplay: mpn, mpnCanonical: mpn, description: "Part", diagramId: "1", supplierPartId: null, newPrice: 10, nla: false
    }));
    const winner = { supplier: "encompass", status: "found" as const, rows, droppedRows: 0, sourceUrl: "https://partstore.encompass.com/model/MAYMVWX655DW1", visited: [], warnings: [], elapsedMs: 1 };
    const saved = await saveModelBom(db, { ...MAYTAG, brandDisplay: "Maytag", modelDisplay: "MVWX655DW1", result: { status: "found", winner, attempts: [winner] } });
    expect(saved).toEqual({ rows: 5, newMpns: 5 });
    const after = await snapshot();
    expect(after.cache[0]).toMatchObject({ status: "found", source: "encompass", rowCount: 5 });
    expect(after.edges.filter((e) => e.brandKey === "MAYTAG").map((e) => e.mpnCanonical)).toEqual(rows.map((r) => r.mpnCanonical));
  });

  it("keeps updating models that were never found", async () => {
    const key = { brandKey: "FRIGIDAIRE", modelKey: "FFTW4120SW1", brandDisplay: "Frigidaire", modelDisplay: "FFTW4120SW1" };
    const status = async () => (await db.select().from(schema.modelBomCache)
      .where(and(eq(schema.modelBomCache.brandKey, key.brandKey), eq(schema.modelBomCache.modelKey, key.modelKey))))[0].status;
    expect(await saveModelBom(db, { ...key, result: { status: "error", winner: null, attempts: [] } })).toEqual({ rows: 0, newMpns: 0 });
    expect(await status()).toBe("error");
    expect(await saveModelBom(db, { ...key, result: { status: "not_found", winner: null, attempts: [] } })).toEqual({ rows: 0, newMpns: 0 });
    expect(await status()).toBe("not_found");
  });
});
