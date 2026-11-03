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
  it("downloads all 216 parts using only the nine requested columns", async () => {
    const response = await request("17");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toMatch(/machine-17-all-parts-.*\.csv/);
    expect(response.headers.get("cache-control")).toContain("no-store");

    const [header, ...rows] = parseCsvRows(await response.text());
    expect(header).toEqual([
      "Machine ID", "Brand", "Model", "Serial", "Physical Location",
      "MPN", "Description", "Test First", "Removal Minutes"
    ]);
    expect(rows).toHaveLength(216);
    expect(rows.every((row) => row.length === 9)).toBe(true);

    const get = (row: string[], name: string) => row[header.indexOf(name)];
    const byMpn = new Map(rows.map((row) => [get(row, "MPN"), row]));
    expect(byMpn.size).toBe(216);
    // Unresearched, prefiltered, pulled and missing rows all remain present.
    expect([...byMpn.keys()]).toEqual(expect.arrayContaining([
      mpn(0), mpn(1), mpn(2), mpn(3), mpn(4), mpn(5), mpn(215)
    ]));
    expect(get(byMpn.get(mpn(215))!, "Machine ID")).toBe("17");
    expect(get(byMpn.get(mpn(215))!, "Brand")).toBe("GE");
    expect(get(byMpn.get(mpn(215))!, "Model")).toBe("TBFM21VAB");
    expect(get(byMpn.get(mpn(215))!, "Serial")).toBe("LG560729");
    expect(get(byMpn.get(mpn(215))!, "Physical Location")).toBe("Graveyard");
    expect(get(byMpn.get(mpn(0))!, "Description")).toBe("Screw");
    // Imported free-text descriptions are protected when opened in Excel.
    expect(get(byMpn.get(mpn(1))!, "Description")).toBe("'=SUM(1,2)");
  });

  it("removes fields from CSV only, never from stored machine, part or sales records", async () => {
    const beforeMachine = await db.select().from(schema.fleetMachines);
    const beforeStates = await db.select().from(schema.machinePartState);
    const beforeSales = await db.select().from(schema.roadrunnerSaleEvents);
    const beforeBom = await db.select().from(schema.modelBomCache);
    const beforeEdges = await db.select().from(schema.modelPartEdges);
    const beforeMaster = await db.select().from(schema.mpnMaster);

    const response = await request("17");
    expect(response.status).toBe(200);
    const [header, ...rows] = parseCsvRows(await response.text());
    expect(rows).toHaveLength(216);
    for (const removed of [
      "Machine Status", "Condition", "Parts List Source", "Parts List Retrieved At",
      "Diagram", "Canonical MPN", "Part Family", "New Price", "Break-even",
      "Qualification", "Qualification Detail", "Roadrunner History (imported)",
      "Roadrunner Units Sold", "Roadrunner Sale Events", "Roadrunner Average Item Price",
      "Roadrunner Last Sold", "Roadrunner Sources", "Part State"
    ]) expect(header).not.toContain(removed);

    expect(await db.select().from(schema.fleetMachines)).toEqual(beforeMachine);
    expect(await db.select().from(schema.machinePartState)).toEqual(beforeStates);
    expect(await db.select().from(schema.roadrunnerSaleEvents)).toEqual(beforeSales);
    expect(await db.select().from(schema.modelBomCache)).toEqual(beforeBom);
    expect(await db.select().from(schema.modelPartEdges)).toEqual(beforeEdges);
    expect(await db.select().from(schema.mpnMaster)).toEqual(beforeMaster);
    expect(beforeMachine.find((m) => m.machineNo === "17")?.availability).toBe("PARTS ONLY");
    expect(beforeStates.find((p) => p.mpnCanonical === mpn(3))?.state).toBe("pulled");
    expect(beforeStates.find((p) => p.mpnCanonical === mpn(4))?.state).toBe("missing");
    expect(beforeSales.find((s) => s.mpnCanonical === mpn(2))?.quantity).toBe(2);
  });

  it("refuses a missing machine or unavailable BOM rather than inventing a complete file", async () => {
    expect((await request("999")).status).toBe(404);
    const response = await request("18");
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/No saved parts list/);
  });
});
