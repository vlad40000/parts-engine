import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { saveModelBom, setPartState, upsertFleet, upsertSaleEvents } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { parseCsvRows } from "@/src/lib/csv";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { GET } from "@/app/api/export/machine-parts/[id]/route";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));

let db: Db;
const mpn = (i: number) => `WR${7000000 + i}`;
const parts: SupplierRow[] = Array.from({ length: 216 }, (_, i) => ({
  mpnDisplay: mpn(i),
  mpnCanonical: mpn(i),
  description: i === 0 ? "Screw" : i === 1 ? "=SUM(1,2)" : `Refrigerator part ${i}`,
  diagramId: `0${Math.floor(i / 72) + 1} - Section${Math.floor(i / 72) + 1}`,
  supplierPartId: null,
  newPrice: i % 2 === 0 ? 19.99 : null,
  nla: false
}));
const chain: ChainResult = {
  status: "found",
  winner: {
    supplier: "appliancepartspros", status: "found", rows: parts, droppedRows: 0,
    sourceUrl: "https://supplier.test/model", visited: [], warnings: [], elapsedMs: 1
  },
  attempts: []
};
const request = (id: string) =>
  GET(new Request(`http://localhost/api/export/machine-parts/${id}`), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    {
      ID: 17, Brand: "GE", ModelNumber: "TBFM21VAB", SerialNumber: "LG560729",
      Availability: "PARTS ONLY", ApplianceType: "Refrigerator - Standard",
      Location: "Graveyard", Condition: "F - Parts Only"
    },
    {
      ID: 18, Brand: "GE", ModelNumber: "MODEL-NO-BOM",
      Availability: "SOLD", ApplianceType: "Refrigerator"
    }
  ]).rows);
  await saveModelBom(db, {
    brandKey: "GE", modelKey: "TBFM21VAB", brandDisplay: "GE",
    modelDisplay: "TBFM21VAB", result: chain
  });
  await setPartState(db, "17", mpn(3), "pulled");
  await setPartState(db, "17", mpn(4), "missing");
  await upsertSaleEvents(db, [{
    mpnCanonical: mpn(2), mpnDisplay: mpn(2),
    sourceEventId: "TEST-ORDER-1", soldAt: "2026-10-01",
    quantity: 2, itemPrice: 45.5, listedAt: null, daysToSell: null, daysToSellSource: null
  }]);
});

describe("machine-specific complete parts CSV export", () => {
  it("downloads every saved model part, including skipped, pulled, missing and unresearched", async () => {
    const response = await request("17");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toMatch(/machine-17-all-parts-.*\.csv/);
    expect(response.headers.get("cache-control")).toContain("no-store");

    const [header, ...rows] = parseCsvRows(await response.text());
    expect(rows).toHaveLength(216);
    const get = (row: string[], name: string) => row[header.indexOf(name)];
    const byMpn = new Map(rows.map((row) => [get(row, "MPN"), row]));
    expect(byMpn.size).toBe(216);
    expect([...byMpn.keys()]).toEqual(expect.arrayContaining([mpn(0), mpn(1), mpn(215)]));
    expect(get(byMpn.get(mpn(0))!, "Qualification")).toBe("skipped");
    expect(get(byMpn.get(mpn(3))!, "Part State")).toBe("pulled");
    expect(get(byMpn.get(mpn(4))!, "Part State")).toBe("missing");
    expect(get(byMpn.get(mpn(5))!, "Qualification")).toBe("not researched");
    expect(get(byMpn.get(mpn(215))!, "Machine ID")).toBe("17");
    expect(get(byMpn.get(mpn(215))!, "Physical Location")).toBe("Graveyard");
    expect(get(byMpn.get(mpn(215))!, "Parts List Source")).toBe("appliancepartspros");
    // Imported free-text descriptions are protected when opened in Excel.
    expect(get(byMpn.get(mpn(1))!, "Description")).toBe("'=SUM(1,2)");
  });

  it("labels imported sales as recorded history, not a part's sale or stock status", async () => {
    const [header, ...rows] = parseCsvRows(await (await request("17")).text());
    const idx = (name: string) => header.indexOf(name);
    const sold = rows.find((r) => r[idx("MPN")] === mpn(2))!;
    const unknown = rows.find((r) => r[idx("MPN")] === mpn(5))!;
    expect(sold[idx("Roadrunner History (imported)")]).toBe("Recorded sales");
    expect(sold[idx("Roadrunner Units Sold")]).toBe("2");
    expect(sold[idx("Roadrunner Sale Events")]).toBe("1");
    expect(sold[idx("Roadrunner Average Item Price")]).toBe("45.50");
    expect(sold[idx("Roadrunner Last Sold")]).toBe("2026-10-01");
    expect(unknown[idx("Roadrunner History (imported)")]).toBe("No recorded sales");
    expect(unknown[idx("Roadrunner Units Sold")]).toBe("");
    expect(unknown[idx("Part State")]).toBe("");
  });

  it("refuses a missing machine or unavailable BOM rather than inventing a complete file", async () => {
    expect((await request("999")).status).toBe(404);
    const response = await request("18");
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/No saved parts list/);
  });
});
