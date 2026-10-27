import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import JSZip from "jszip";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { fleetMpnExportRows, researchQueueCsvRows, saveModelBom, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { parseSharedResearchCsv } from "@/src/lib/shared-research-csv";
import { parseCsvRows } from "@/src/lib/csv";
import type { ChainResult } from "@/src/sources/chain";
import { GET as exportFleetMpns } from "@/app/api/export/fleet-mpns/route";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));

let db: Db;
const machine = (id: number, status: string, model: string) => ({
  ID: id, Availability: status, ApplianceType: "Washer", Brand: "Whirlpool", ModelNumber: model, SerialNumber: ""
});
const chain = (mpns: string[]): ChainResult => ({
  status: "found",
  winner: {
    supplier: "encompass", status: "found",
    rows: mpns.map((mpn) => ({
      mpnDisplay: mpn, mpnCanonical: mpn, description: `Part ${mpn}`,
      diagramId: "1", supplierPartId: null, newPrice: 20, nla: false
    })),
    droppedRows: 0, sourceUrl: "https://supplier.test", visited: [], warnings: [], elapsedMs: 1
  },
  attempts: []
});
const url = (query: string) => new Request("http://localhost/api/export/fleet-mpns" + query);
const keys = (csv: string) => {
  const parsed = parseSharedResearchCsv(csv);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rows.map((r) => r.mpnCanonical);
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    machine(1, "PARTS ONLY", "MODEL-A"),
    machine(2, "SOLD", "MODEL-B"),
    machine(3, "SCRAPPED", "MODEL-C"),
    machine(4, "UNCHECKED", "MODEL-D"),
    machine(5, "READY TO SALE", "MODEL-E"),
    machine(6, "SCRAPED", "MODEL-C"),
    machine(7, "NEEDS PARTS", "MODEL-F"),
    machine(8, "PARTS PROGRAM", "MODEL-A"),
    machine(9, "SOLD", "NO-BOM")
  ]).rows);
  for (const [model, mpns] of [
    ["MODEL-A", ["COMMON123", "ACTIVE123"]],
    ["MODEL-B", ["COMMON123", "SOLD123"]],
    ["MODEL-C", ["COMMON123", "SCRAP123"]],
    ["MODEL-D", ["CHECK123"]],
    ["MODEL-E", ["READY123"]],
    ["MODEL-F", ["NEEDS123"]]
  ] as const) {
    await saveModelBom(db, {
      brandKey: "WHIRLPOOL", modelKey: model.replace(/[^A-Z0-9]/g, ""), brandDisplay: "Whirlpool",
      modelDisplay: model, result: chain([...mpns])
    });
  }
  // A current researched MPN must still appear in the fleet-wide export.
  await db.insert(schema.marketFacts).values({
    mpnCanonical: "COMMON123", sold90: 50, avgPrice: "55.00",
    sellThroughPct: "50.00", sellThroughSource: "manual",
    researchedAt: new Date().toISOString().slice(0, 10), source: "manual"
  });
  // A removed part still has historical model fitment; export never claims it is in stock.
  await db.insert(schema.machinePartState).values({ machineNo: "1", mpnCanonical: "ACTIVE123", state: "pulled" });
});

describe("fleet-wide status-scoped research export", () => {
  it("is independent of qualification, researched status, donor settings and shop-floor part state", async () => {
    const rows = await fleetMpnExportRows(db, null);
    expect(rows.map((row) => row.mpnCanonical).sort()).toEqual([
      "ACTIVE123", "CHECK123", "COMMON123", "NEEDS123", "READY123", "SCRAP123", "SOLD123"
    ]);
    expect(rows.find((row) => row.mpnCanonical === "COMMON123")?.notes)
      .toContain("5 matching machine(s)");
    expect(rows.find((row) => row.mpnCanonical === "ACTIVE123")?.notes)
      .toContain("Not confirmed physical stock");
    // Existing queue behavior is NOT broadened by this feature.
    expect((await researchQueueCsvRows(db)).some((r) => r.mpn_canonical === "COMMON123")).toBe(false);
  });

  it("includes sold/scrapped and legacy scraped models only when explicitly selected, with no duplicate MPNs", async () => {
    const sold = await fleetMpnExportRows(db, ["SOLD"]);
    expect(sold.map((r) => r.mpnCanonical).sort()).toEqual(["COMMON123", "SOLD123"]);
    const two = await fleetMpnExportRows(db, ["SOLD", "SCRAPPED", "SCRAPED"]);
    expect(two.map((r) => r.mpnCanonical).sort()).toEqual(["COMMON123", "SCRAP123", "SOLD123"]);
    expect(two.find((r) => r.mpnCanonical === "COMMON123")?.notes)
      .toContain("SOLD");
    expect(two.find((r) => r.mpnCanonical === "COMMON123")?.notes)
      .toContain("SCRAPED");
    expect(two.find((r) => r.mpnCanonical === "COMMON123")?.notes)
      .toContain("SCRAPPED");
    expect((await fleetMpnExportRows(db, ["UNCHECKED"])).map((r) => r.mpnCanonical))
      .toEqual(["CHECK123"]);
    expect((await fleetMpnExportRows(db, ["READY TO SALE"])).map((r) => r.mpnCanonical))
      .toEqual(["READY123"]);
  });

  it("downloads all machine statuses as a deduplicated import-compatible ZIP without modifying the queue", async () => {
    const before = (await researchQueueCsvRows(db)).map((r) => r.mpn_canonical);
    const response = await exportFleetMpns(url("?all=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const csvNames = Object.keys(zip.files).filter((name) => name.endsWith(".csv"));
    expect(csvNames).toHaveLength(1);
    expect(keys(await zip.files[csvNames[0]].async("string"))).toHaveLength(7);
    const readme = await zip.files["README.txt"].async("string");
    expect(readme).toContain("ALL STATUSES");
    expect(readme).toContain("does NOT prove");
    expect(readme).toContain("Machines without cached BOMs");
    expect((await researchQueueCsvRows(db)).map((r) => r.mpn_canonical)).toEqual(before);
  });

  it("downloads selected status ZIP or individual CSV and preserves original shared headers", async () => {
    const query = "?scope=selected&status=SOLD&status=SCRAPPED&status=SCRAPED";
    const result = await exportFleetMpns(url(query + "&all=1"));
    expect(result.status).toBe(200);
    const zip = await JSZip.loadAsync(await result.arrayBuffer());
    const file = Object.keys(zip.files).find((name) => name.endsWith(".csv"))!;
    expect(keys(await zip.files[file].async("string")).sort()).toEqual(["COMMON123", "SCRAP123", "SOLD123"]);
    expect(await zip.files["README.txt"].async("string")).toContain("SOLD, SCRAPPED, SCRAPED");

    const single = await exportFleetMpns(url(query + "&batch=1"));
    expect(single.status).toBe(200);
    expect(parseCsvRows(await single.text())[0]).toEqual([
      "mpn", "description", "notes", "New Price", "7 Day sales", "7 Day Avg Price",
      "30 Day sales", "30 Day Avg Price", "90 Day sales", "90 Day Avg Price", "90 Day Sell Through %"
    ]);
  });

  it("rejects missing/invalid selections and nonexistent batches without silently broadening the scope", async () => {
    for (const query of [
      "?scope=selected&all=1",
      "?status=SOLD&all=1",
      "?scope=selected&status=UNKNOWN&all=1",
      "?all=1&batch=1",
      "?scope=other&all=1"
    ]) expect((await exportFleetMpns(url(query))).status).toBe(400);
    expect((await exportFleetMpns(url("?scope=selected&status=SOLD&batch=2"))).status).toBe(422);
  });
});
