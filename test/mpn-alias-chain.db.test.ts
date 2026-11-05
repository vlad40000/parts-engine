import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { asc, eq } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { addAlias, loadAliasChains, saveModelBom } from "@/src/db/queries";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";

/**
 * Real Whirlpool chain from the WTW8120HW0 parts list (W11429298): the Rev A hose clamp W10142630
 * became W11375994 in Rev B, which is now sold as WP285655, the WP service pack of 285655.
 */
const CHAIN: Array<[string, string, "supersedes" | "wp_prefix"]> = [
  ["W10142630", "W11375994", "supersedes"],
  ["W11375994", "WP285655", "supersedes"],
  ["WP285655", "285655", "wp_prefix"]
];

let db: Db;
const supplierRow = (mpn: string, description: string): SupplierRow => ({
  mpnDisplay: mpn, mpnCanonical: mpn, description, diagramId: "Gearcase, Motor & Pump", supplierPartId: null, newPrice: 7.21, nla: false
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  for (const [alias, target, kind] of CHAIN) await addAlias(db, alias, target, kind);
});

describe("MPN alias chains", () => {
  it("reads the whole chain without re-keying anything", async () => {
    const chain = await loadAliasChains(db, CHAIN.map(([alias]) => alias));
    for (const [alias] of CHAIN) expect(chain(alias).canonical).toBe("285655");
    expect(chain("W10142630").hops).toEqual(["W11375994", "WP285655", "285655"]);
    expect(chain("W11419052")).toEqual({ canonical: "W11419052", hops: [], loop: false });
  });

  it("parts lists keep resolving one hop, so part states recorded under that key still join", async () => {
    const result: ChainResult = {
      status: "found",
      winner: {
        supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1,
        rows: [["W10142630", "Clamp, Hose"], ["W11419052", "Control"], ["W11449841", "Drive"], ["W11195971", "Stator"], ["W11260238", "Rotor"]]
          .map(([mpn, d]) => supplierRow(mpn, d))
      },
      attempts: []
    };
    await saveModelBom(db, { brandKey: "WHIRLPOOL", modelKey: "WTW8120HW0", brandDisplay: "Whirlpool", modelDisplay: "WTW8120HW0", result });
    const [clamp] = await db.select().from(schema.modelPartEdges).where(eq(schema.modelPartEdges.description, "Clamp, Hose"));
    expect(clamp.mpnCanonical).toBe("W11375994");
    expect(clamp.mpnDisplay).toBe("W10142630");
  });

  it("an alias that would close a loop is refused and nothing is saved", async () => {
    await expect(addAlias(db, "285655", "W10142630", "supersedes")).rejects.toThrow(/loop/);
    await expect(addAlias(db, "W11375994", "W10142630", "supersedes")).rejects.toThrow(/loop/);
    const rows = await db.select().from(schema.mpnAlias).orderBy(asc(schema.mpnAlias.aliasCanonical));
    expect(rows.map((r) => [r.aliasCanonical, r.mpnCanonical])).toEqual([
      ["W10142630", "W11375994"], ["W11375994", "WP285655"], ["WP285655", "285655"]
    ]);
  });

  it("the entered relationship is stored as typed, not flattened to the chain end", async () => {
    await addAlias(db, "W10006482", "W10142630", "supersedes");
    const [row] = await db.select().from(schema.mpnAlias).where(eq(schema.mpnAlias.aliasCanonical, "W10006482"));
    expect(row.mpnCanonical).toBe("W10142630");
  });

  it("a loop already in the data resolves to nothing instead of hanging or picking a side", async () => {
    await db.insert(schema.mpnAlias).values([
      { aliasCanonical: "LOOPA1", mpnCanonical: "LOOPB1", kind: "variant", source: "legacy" },
      { aliasCanonical: "LOOPB1", mpnCanonical: "LOOPA1", kind: "variant", source: "legacy" }
    ]);
    expect((await loadAliasChains(db, ["LOOPA1"]))("LOOPA1")).toMatchObject({ canonical: "LOOPA1", loop: true });
    await expect(addAlias(db, "W11999999", "LOOPA1", "variant")).rejects.toThrow(/loop/);
  });
});
