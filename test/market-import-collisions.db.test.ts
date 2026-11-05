import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import ExcelJS from "exceljs";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { addAlias, upsertMarketFacts } from "@/src/db/queries";
import { mapMarketRows } from "@/src/lib/market-import";
import { importMarketAction } from "@/app/actions";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

let client: PGlite;
let db: Db;
const rows = (keys: string[]) => mapMarketRows(keys.map((mpn) => ({ mpn, sold90: 9, avg_price: 35 }))).rows;
const snapshot = async () => ({
  facts: await db.select().from(schema.marketFacts),
  master: await db.select().from(schema.mpnMaster)
});

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await addAlias(db, "OLDPART", "NEWPART", "supersedes");
  await addAlias(db, "WPW10006355", "W10006355", "wp_prefix");
  await upsertMarketFacts(db, rows(["EXISTING"]), "seed");
});
afterAll(async () => { await client.close(); });

describe("market import collision preflight", () => {
  it.each([
    ["direct replacement", ["OLDPART", "NEWPART"]],
    ["WP prefix", ["WPW10006355", "W10006355"]],
    ["normalized duplicate", ["new-part", "NEW PART"]]
  ])("rejects %s collisions without changing facts or master rows", async (_label, keys) => {
    const before = await snapshot();
    await expect(upsertMarketFacts(db, rows(["UNSAVED", ...keys]), "test"))
      .rejects.toThrow(/Keep one entry per MPN; nothing was imported/);
    expect(await snapshot()).toEqual(before);
  });

  it.each([false, true])("checks the entire file before writes (collision spans batches: %s)", async (acrossBatches) => {
    const input = rows(["EXISTING", ...Array.from({ length: 299 }, (_, i) => `BATCH${i}`), "OLDPART", "NEWPART"]);
    input[0].sold90 = 999;
    if (acrossBatches) [input[0], input[300]] = [input[300], input[0]];
    const before = await snapshot();
    await expect(upsertMarketFacts(db, input, "test")).rejects.toThrow(/NEWPART/);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["csv", "xlsx"])("returns an actionable %s upload error without saving", async (extension) => {
    let content: BlobPart = "mpn,sold90\nOLDPART,8\nNEWPART,9\n";
    if (extension === "xlsx") {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("MPN Master");
      ws.addRows([["mpn", "sold90"], ["OLDPART", 8], ["NEWPART", 9]]);
      content = await wb.xlsx.writeBuffer();
    }
    const form = new FormData();
    form.set("file", new File([content], `market.${extension}`));
    const before = await snapshot();
    expect(await importMarketAction(null, form)).toMatchObject({
      ok: false,
      message: "Import entries 1, 2 resolve to the same MPN (NEWPART). Keep one entry per MPN; nothing was imported."
    });
    expect(await snapshot()).toEqual(before);
  });

  it("still saves unique rows with one-hop aliases and reports unchanged counts", async () => {
    await addAlias(db, "CHAINSTART", "CHAINMID", "supersedes");
    await addAlias(db, "CHAINMID", "CHAINEND", "supersedes");
    expect(await upsertMarketFacts(db, rows(["EXISTING", "OLDPART", "CHAINSTART", "CHAINEND"]), "test"))
      .toEqual({ saved: 4, unknown: 3 });
    const saved = await snapshot();
    expect(saved.facts.map((r) => r.mpnCanonical).sort()).toEqual(["CHAINEND", "CHAINMID", "EXISTING", "NEWPART"]);
    expect(saved.master.map((r) => r.mpnCanonical).sort()).toEqual(["CHAINEND", "CHAINMID", "EXISTING", "NEWPART"]);
    expect(await upsertMarketFacts(db, [], "test")).toEqual({ saved: 0, unknown: 0 });
  });
});
