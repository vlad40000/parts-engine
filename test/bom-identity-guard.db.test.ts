import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { readModelBom } from "@/src/lib/model-bom";
import type { Fetcher } from "@/src/sources/types";

const fx = (p: string) => readFileSync(path.join(__dirname, "fixtures", p), "utf8");
const MAYTAG_PAGE = "https://www.appliancepartspros.com/parts-for-maytag-mvwx655dw1.html";

/** Encompass has no page; the AppliancePartsPros search lands on Maytag MVWX655DW1 whatever was asked. */
const redirecting: Fetcher = async (url) => {
  if (url.includes("encompass")) return { ok: true, status: 200, finalUrl: url, html: "does not exist in our database" };
  if (url.includes("search.aspx")) return { ok: true, status: 200, finalUrl: MAYTAG_PAGE, html: fx("app/MVWX655DW1-model.html") };
  return { ok: true, status: 200, finalUrl: url, html: fx("app/MVWX655DW1-top.html") };
};

let db: Db;
const cacheRow = async (brandKey: string, modelKey: string) =>
  (await db.select().from(schema.modelBomCache)
    .where(and(eq(schema.modelBomCache.brandKey, brandKey), eq(schema.modelBomCache.modelKey, modelKey))))[0];
const edgeCount = (brandKey: string, modelKey: string) =>
  db.$count(schema.modelPartEdges, and(eq(schema.modelPartEdges.brandKey, brandKey), eq(schema.modelPartEdges.modelKey, modelKey)));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
});

describe("a supplier page for another model is never saved", () => {
  it("records the rejected landing page and writes no parts, MPNs or aliases", async () => {
    const { result, saved } = await readModelBom(db, { brand: "Frigidaire", model: "FFTW4120SW1" }, redirecting);
    expect(result).toMatchObject({ status: "not_found", winner: null });
    expect(saved).toEqual({ rows: 0, newMpns: 0 });
    const cache = await cacheRow("FRIGIDAIRE", "FFTW4120SW1");
    expect(cache).toMatchObject({ status: "not_found", source: null, sourceUrl: null, rowCount: 0 });
    // The evidence stays reviewable: which page the supplier offered and why it was refused.
    expect(cache.warnings).toContain(
      `appliancepartspros: AppliancePartsPros returned ${MAYTAG_PAGE}, which is not Frigidaire FFTW4120SW1; nothing was read from it.`);
    expect(await edgeCount("FRIGIDAIRE", "FFTW4120SW1")).toBe(0);
    expect(await db.$count(schema.mpnMaster)).toBe(0);
    expect(await db.$count(schema.mpnAlias)).toBe(0);
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
