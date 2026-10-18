import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, asc, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { bomQueue, getSettings, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { readModelBom } from "@/src/lib/model-bom";
import type { Fetcher, FetchResult } from "@/src/sources/types";

const fx = (p: string) => readFileSync(path.join(__dirname, "fixtures", p), "utf8");
const PAGE = fx("encompass/model-page.html");
/** The same page without its embedded data: only the 10 rows on screen, under 13 "Go to page" buttons. */
const TABLE_ONLY = PAGE.replace(/<script>self\.__next_f\.push\([\s\S]*?<\/script>/g, "");
const MAY = "https://partstore.encompass.com/model/MAYMEDC465HW0";
/** Encompass files this model under MAY and lists three pages for it. */
const PAGED = PAGE.replace("</body>", '<a href="/model/MAYMEDC465HW0/_/2">2</a><a href="/model/MAYMEDC465HW0/_/3">3</a></body>');
const ok = (url: string, html: string, finalUrl = url): FetchResult => ({ ok: true, status: 200, finalUrl, html });

/** Encompass serves `first` and then `later` for each listed page; AppliancePartsPros has no page for the model. */
const encompass = (first: string, later: (url: string) => FetchResult): Fetcher => async (url) => {
  if (url.includes("appliancepartspros")) return { ok: false, status: 404, finalUrl: url, html: "" };
  if (url === MAY) return ok(url, first);
  if (url.startsWith(`${MAY}/_/`)) return later(url);
  return ok(url, "Oops! This part or model# does not exist in our database.");
};
const complete = encompass(PAGED, (url) => ok(url, PAGE));

/** Every way a listed Encompass page can fail to be this model's page N, and the warning it leaves. */
const INCOMPLETE: Record<string, { fetcher: Fetcher; warning: string }> = {
  "page 2 answers HTTP 200 that the model does not exist": {
    fetcher: encompass(PAGED, (url) => ok(url, url.endsWith("/2") ? "Oops! This part or model# does not exist in our database." : PAGE)),
    warning: `encompass: Encompass page 2 of 3 answered that the model does not exist for ${MAY}; the catalog is incomplete and nothing was saved.`
  },
  "page 2 has no parseable parts": {
    fetcher: encompass(PAGED, (url) => ok(url, url.endsWith("/2") ? "<html><body><h1>We'll be right back</h1></body></html>" : PAGE)),
    warning: `encompass: Encompass page 2 of 3 had no parseable parts for ${MAY}; the catalog is incomplete and nothing was saved.`
  },
  "page 3 lands back on page 1": {
    fetcher: encompass(PAGED, (url) => ok(url, PAGE, url.endsWith("/3") ? MAY : url)),
    warning: `encompass: Encompass page 3 of 3 landed on ${MAY}, not page 3 for ${MAY}; the catalog is incomplete and nothing was saved.`
  },
  "page 2 holds only the rows on screen": {
    fetcher: encompass(PAGED, (url) => ok(url, url.endsWith("/2") ? TABLE_ONLY : PAGE)),
    warning: `encompass: Encompass page 2 of 3 holds only the visible part of its list (it pages 10 rows at a time over 13 pages and carries 10) for ${MAY}; the catalog is incomplete and nothing was saved.`
  },
  "the first page holds only the rows on screen": {
    fetcher: encompass(TABLE_ONLY, (url) => ok(url, PAGE)),
    warning: `encompass: Encompass page ${MAY} holds only the visible part of its parts list (it pages 10 rows at a time over 13 pages and carries 10); the catalog was rejected as incomplete.`
  }
};

let db: Db;
let donors: string[];
const MODEL = { brand: "Maytag", model: "MEDC465HW0" };
const filter = { availability: "PARTS ONLY" };
const snapshot = async () => ({
  cache: await db.select().from(schema.modelBomCache)
    .where(and(eq(schema.modelBomCache.brandKey, "MAYTAG"), eq(schema.modelBomCache.modelKey, "MEDC465HW0"))),
  edges: await db.select().from(schema.modelPartEdges).orderBy(asc(schema.modelPartEdges.mpnCanonical)),
  mpns: await db.select().from(schema.mpnMaster).orderBy(asc(schema.mpnMaster.mpnCanonical)),
  aliases: await db.select().from(schema.mpnAlias).orderBy(asc(schema.mpnAlias.aliasCanonical))
});
const queued = async (queue?: "retry") =>
  (await bomQueue(db, { ...filter, queue }, donors)).rows.map((r) => `${r.brand_key} ${r.model_key} ${r.bom_status}`);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  donors = (await getSettings(db)).donorAvailabilities;
  await upsertFleet(db, mapFleetRows([
    { ID: 1, Availability: "PARTS ONLY", ApplianceType: "Dryer - Electric", Brand: "Maytag", ModelNumber: "MEDC465HW0", SerialNumber: "" }
  ]).rows);
});

afterEach(() => vi.restoreAllMocks());

describe("an incomplete Encompass catalog is never saved", () => {
  for (const [scenario, { fetcher, warning }] of Object.entries(INCOMPLETE)) {
    it(`writes no parts, MPNs or success and keeps a new model in Retries when ${scenario}`, async () => {
      const { result, saved } = await readModelBom(db, MODEL, fetcher);
      expect(result).toMatchObject({ status: "error", winner: null });
      expect(result.attempts.map((a) => [a.supplier, a.status])).toEqual([["encompass", "error"], ["appliancepartspros", "not_found"]]);
      expect(saved).toEqual({ rows: 0, newMpns: 0 });
      const after = await snapshot();
      expect(after.cache).toEqual([expect.objectContaining({ status: "error", source: null, sourceUrl: null, rowCount: 0 })]);
      expect(after.cache[0].warnings).toContain(warning);
      expect(after.edges).toEqual([]);
      expect(after.mpns).toEqual([]);
      expect(after.aliases).toEqual([]);
      expect(await queued("retry")).toEqual(["MAYTAG MEDC465HW0 error"]);
      expect(await queued()).toEqual([]);
    });
  }

  it("saves the catalog once every listed page is read", async () => {
    const { result, saved } = await readModelBom(db, MODEL, complete);
    expect(result.status).toBe("found");
    expect(result.winner).toMatchObject({ supplier: "encompass", sourceUrl: MAY });
    expect(result.winner?.visited).toEqual(["https://partstore.encompass.com/model/WHIMEDC465HW0", MAY, `${MAY}/_/2`, `${MAY}/_/3`]);
    expect(saved).toMatchObject({ rows: 124 });
    const after = await snapshot();
    expect(after.cache[0]).toMatchObject({ status: "found", source: "encompass", sourceUrl: MAY, rowCount: 124 });
    expect(after.edges).toHaveLength(124);
    expect(await queued("retry")).toEqual([]);
  });

  for (const [scenario, { fetcher }] of Object.entries(INCOMPLETE)) {
    it(`keeps the verified catalog unchanged when ${scenario}`, async () => {
      const before = await snapshot();
      expect(before.cache[0]).toMatchObject({ status: "found", rowCount: 124 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { result, saved } = await readModelBom(db, MODEL, fetcher);
      expect(result).toMatchObject({ status: "error", winner: null });
      expect(saved).toEqual({ rows: 0, newMpns: 0, kept: { rowCount: 124, fetchedAt: before.cache[0].fetchedAt } });
      expect(await snapshot()).toEqual(before);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Parts list lookup for Maytag MEDC465HW0 ended error; the verified list from"));
      expect(await queued("retry")).toEqual([]);
      expect(await queued()).toEqual([]);
    });
  }
});
