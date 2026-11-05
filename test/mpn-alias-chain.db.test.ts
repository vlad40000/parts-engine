import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { asc, eq } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { addAlias, loadAliasChains, mpnDetail, saveModelBom, upsertMarketFacts } from "@/src/db/queries";
import type { MarketRow } from "@/src/lib/market-import";
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
const bom = (rows: SupplierRow[]): ChainResult => ({
  status: "found",
  winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: []
});
const market = (mpn: string, sold90: number): MarketRow => ({
  mpnCanonical: mpn, mpnDisplay: mpn, description: "Clamp, Hose", sold90, avgPrice: 9.5, avgShip: null, sellThroughPct: null,
  sellThroughSource: null, activeQty: 12, qtyOnHand: null, researchedAt: "2026-11-05", freeShipping: false, shipCost: null
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  for (const [alias, target, kind] of CHAIN) await addAlias(db, alias, target, kind);
});

describe("MPN alias chains", () => {
  it("every number in the chain lands on the last one", async () => {
    const chain = await loadAliasChains(db, CHAIN.map(([alias]) => alias));
    for (const [alias] of CHAIN) expect(chain(alias).canonical).toBe("285655");
    expect(chain("W10142630").hops).toEqual(["W11375994", "WP285655", "285655"]);
    expect(chain("W11419052")).toEqual({ canonical: "W11419052", hops: [], loop: false });
  });

  it("a parts list that lists the oldest number is stored on the chain end, keeping the printed number", async () => {
    await saveModelBom(db, {
      brandKey: "WHIRLPOOL", modelKey: "WTW8120HW0", brandDisplay: "Whirlpool", modelDisplay: "WTW8120HW0",
      result: bom([
        supplierRow("W10142630", "Clamp, Hose"),
        supplierRow("W11419052", "Control"),
        supplierRow("W11449841", "Drive Assembly"),
        supplierRow("W11195971", "Stator"),
        supplierRow("W11260238", "Rotor")
      ])
    });
    const edges = await db.select().from(schema.modelPartEdges).where(eq(schema.modelPartEdges.modelKey, "WTW8120HW0"))
      .orderBy(asc(schema.modelPartEdges.mpnCanonical));
    const clamp = edges.find((e) => e.description === "Clamp, Hose")!;
    expect(clamp.mpnCanonical).toBe("285655");
    expect(clamp.mpnDisplay).toBe("W10142630");
    expect(edges.map((e) => e.mpnCanonical)).not.toContain("W10142630");
    expect(edges.map((e) => e.mpnCanonical)).not.toContain("WP285655");
  });

  it("the MPN page opened by any old number shows the chain end and every number that leads to it", async () => {
    for (const [alias] of CHAIN) {
      const detail = await mpnDetail(db, alias);
      expect(detail?.mpn.mpn_canonical).toBe("285655");
    }
    const detail = (await mpnDetail(db, "285655"))!;
    expect(detail.aliases.map((a) => a.aliasCanonical).sort()).toEqual(["W10142630", "W11375994", "WP285655"]);
    expect(detail.machines).toEqual([]);
    expect(detail.models.map((m) => m.model_key)).toEqual(["WTW8120HW0"]);
  });

  it("market facts imported under a middle number land on the chain end", async () => {
    await upsertMarketFacts(db, [market("W11375994", 7)], "test");
    const [facts] = await db.select().from(schema.marketFacts).where(eq(schema.marketFacts.mpnCanonical, "285655"));
    expect(facts?.sold90).toBe(7);
    expect(await db.select().from(schema.marketFacts).where(eq(schema.marketFacts.mpnCanonical, "W11375994"))).toEqual([]);
    expect(await db.select().from(schema.marketFacts).where(eq(schema.marketFacts.mpnCanonical, "WP285655"))).toEqual([]);
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
    expect((await loadAliasChains(db, ["W10006482"]))("W10006482").canonical).toBe("285655");
  });

  it("a loop already in the data resolves to nothing instead of hanging or picking a side", async () => {
    await db.insert(schema.mpnAlias).values([
      { aliasCanonical: "LOOPA1", mpnCanonical: "LOOPB1", kind: "variant", source: "legacy" },
      { aliasCanonical: "LOOPB1", mpnCanonical: "LOOPA1", kind: "variant", source: "legacy" }
    ]);
    const chain = await loadAliasChains(db, ["LOOPA1"]);
    expect(chain("LOOPA1")).toMatchObject({ canonical: "LOOPA1", loop: true });
  });
});
