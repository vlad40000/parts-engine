import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, inArray } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  machineDetail, mpnDetail, partDispositionHistory, saveModelBom, setPartDisposition, setPartState, upsertFleet
} from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { parseCsvRows } from "@/src/lib/csv";
import { HISTORICAL_DESCRIPTION_MARKER, machinePartsExportable } from "@/src/lib/machine-parts-export";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { GET } from "@/app/api/export/machine-parts/[id]/route";

/**
 * Historical parts without a found parts list, and historical part states whose MPN has no mpn_master record.
 * Both must download (same nine CSV columns, Description marked historical) and stay on the machine page with
 * the recorded MPN and state, without invented metadata and without becoming donor stock.
 */
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));

let db: Db;
const CATALOGUED = "WE98X00001";
const CURRENT = "WE98X00002";
const NO_RECORD_FAILED = "WE98X09901";
const NO_RECORD_REPAIR = "WE98X09902";
const NO_RECORD_SOLD = "WE98X09903";
const NO_RECORD = [NO_RECORD_FAILED, NO_RECORD_REPAIR, NO_RECORD_SOLD];
const HEADER = ["Machine ID", "Brand", "Model", "Serial", "Physical Location", "MPN", "Description", "Test First", "Removal Minutes"];

const row = (mpn: string): SupplierRow => ({
  mpnDisplay: mpn, mpnCanonical: mpn, description: `Fixture part ${mpn}`, diagramId: "01 - Fixture Section",
  supplierPartId: null, newPrice: 10, nla: false
});
const save = (modelKey: string, result: ChainResult) =>
  saveModelBom(db, { brandKey: "GE", modelKey, brandDisplay: "GE", modelDisplay: modelKey, result });
const request = (id: string) =>
  GET(new Request(`http://localhost/api/export/machine-parts/${id}`), { params: Promise.resolve({ id }) });
const exportCsv = async (id: string) => {
  const response = await request(id);
  expect(response.status).toBe(200);
  const [header, ...rows] = parseCsvRows(await response.text());
  const byMpn = new Map(rows.map((r) => [r[header.indexOf("MPN")], r]));
  return { header, rows, byMpn, description: (mpn: string) => byMpn.get(mpn)?.[header.indexOf("Description")] };
};
const step = async (machineNo: string, mpnCanonical: string, from: "ebay" | "listed" | null, next: "ebay" | "listed" | "sold" | "repair",
  extra: { soldPrice?: string; repairMachineNo?: string } = {}) =>
  expect(await setPartDisposition(db, { machineNo, mpnCanonical, from, step: next, ...extra })).toBe("saved");
const partsOf = async (machineNo: string) => new Map((await machineDetail(db, machineNo))!.parts.map((p) => [p.mpn_canonical, p]));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    // 41: its model's parts list is not_found. 42: its model's list was never read. 43: no list and no states.
    // 44: a found list, plus a part state whose MPN has no record. 45: an untouched donor of 44's model.
    { ID: 41, Brand: "GE", ModelNumber: "GTD33EASK0WW", SerialNumber: "FIXTURE-41", Availability: "PARTS ONLY", ApplianceType: "Dryer" },
    { ID: 42, Brand: "GE", ModelNumber: "GTD45EASJ0WS", SerialNumber: "FIXTURE-42", Availability: "PARTS ONLY", ApplianceType: "Dryer" },
    { ID: 43, Brand: "GE", ModelNumber: "GTD65EBSJ2WS", SerialNumber: "FIXTURE-43", Availability: "PARTS ONLY", ApplianceType: "Dryer" },
    { ID: 44, Brand: "GE", ModelNumber: "GTD42EASJ2WW", SerialNumber: "FIXTURE-44", Availability: "PARTS ONLY", ApplianceType: "Dryer" },
    { ID: 45, Brand: "GE", ModelNumber: "GTD42EASJ2WW", SerialNumber: "FIXTURE-45", Availability: "PARTS ONLY", ApplianceType: "Dryer" }
  ]).rows);
  // CATALOGUED gets an mpn_master record from another model's found list; GTD42 lists only CURRENT.
  await save("GTD81ESSJ2WS", { status: "found", winner: {
    supplier: "appliancepartspros", status: "found", rows: [row(CATALOGUED)], droppedRows: 0,
    sourceUrl: "https://supplier.test/other", visited: [], warnings: [], elapsedMs: 1
  }, attempts: [] });
  await save("GTD42EASJ2WW", { status: "found", winner: {
    supplier: "appliancepartspros", status: "found", rows: [row(CURRENT)], droppedRows: 0,
    sourceUrl: "https://supplier.test/model", visited: [], warnings: [], elapsedMs: 1
  }, attempts: [] });
  await save("GTD33EASK0WW", { status: "not_found", winner: null, attempts: [] });

  await setPartState(db, "41", CATALOGUED, "pulled");
  await step("41", CATALOGUED, null, "ebay");
  await step("41", CATALOGUED, "ebay", "sold", { soldPrice: "25.00" });
  await setPartState(db, "41", NO_RECORD_FAILED, "failed");
  await setPartState(db, "41", NO_RECORD_REPAIR, "pulled");
  await step("41", NO_RECORD_REPAIR, null, "repair", { repairMachineNo: "44" });
  await setPartState(db, "42", NO_RECORD_SOLD, "pulled");
  await step("42", NO_RECORD_SOLD, null, "ebay");
  await step("42", NO_RECORD_SOLD, "ebay", "sold", { soldPrice: "12.50" });
  await setPartState(db, "44", NO_RECORD_FAILED, "failed");
  // A family match would mark a catalogued part test first; an unknown family must not.
  await db.update(schema.fleetMachines).set({ suspectFamilies: ["other"] }).where(inArray(schema.fleetMachines.machineNo, ["41", "44"]));
}, 30000);

describe("historical parts without a found parts list", () => {
  it("shows recorded parts on a machine whose parts list is not_found, and allows the download", async () => {
    const detail = (await machineDetail(db, "41"))!;
    expect(detail.bom?.status).toBe("not_found");
    expect(detail.parts.every((p) => p.historical)).toBe(true);
    expect(machinePartsExportable(detail)).toBe(true);
    const parts = new Map(detail.parts.map((p) => [p.mpn_canonical, p]));
    expect([...parts.keys()].sort()).toEqual([CATALOGUED, NO_RECORD_FAILED, NO_RECORD_REPAIR].sort());
    expect(parts.get(CATALOGUED)).toMatchObject({
      mpnRecord: true, mpn_display: CATALOGUED, description: `Fixture part ${CATALOGUED}`,
      state: "pulled", disposition: "sold", soldPrice: "25.00"
    });
    expect(parts.get(NO_RECORD_REPAIR)).toMatchObject({ mpnRecord: false, state: "pulled", disposition: "repair", repairMachineNo: "44" });
  });

  it("allows the download when the model's parts list was never read", async () => {
    const detail = (await machineDetail(db, "42"))!;
    expect(detail.bom).toBeUndefined();
    expect(machinePartsExportable(detail)).toBe(true);
    const { header, rows, description } = await exportCsv("42");
    expect(header).toEqual(HEADER);
    expect(rows).toHaveLength(1);
    expect(rows[0][header.indexOf("Machine ID")]).toBe("42");
    expect(rows[0][header.indexOf("MPN")]).toBe(NO_RECORD_SOLD);
    expect(description(NO_RECORD_SOLD)).toBe(HISTORICAL_DESCRIPTION_MARKER);
  });

  it("marks historical rows in the CSV Description, keeps nine columns, and leaves stored descriptions unchanged", async () => {
    const { header, rows, description } = await exportCsv("41");
    expect(header).toEqual(HEADER);
    expect(rows.every((r) => r.length === 9)).toBe(true);
    expect(description(CATALOGUED)).toBe(`${HISTORICAL_DESCRIPTION_MARKER} Fixture part ${CATALOGUED}`);
    expect(description(NO_RECORD_FAILED)).toBe(HISTORICAL_DESCRIPTION_MARKER);
    expect(description(NO_RECORD_REPAIR)).toBe(HISTORICAL_DESCRIPTION_MARKER);
    const [stored] = await db.select().from(schema.mpnMaster).where(eq(schema.mpnMaster.mpnCanonical, CATALOGUED));
    expect(stored.description).toBe(`Fixture part ${CATALOGUED}`);
  });

  it("still refuses a machine with neither a found parts list nor recorded parts", async () => {
    const detail = (await machineDetail(db, "43"))!;
    expect(detail.parts).toEqual([]);
    expect(machinePartsExportable(detail)).toBe(false);
    const response = await request("43");
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/No saved parts list/);
  });
});

describe("historical part states with no MPN record", () => {
  it("keeps the recorded MPN and state without inventing catalogue metadata", async () => {
    const parts = await partsOf("41");
    const failed = parts.get(NO_RECORD_FAILED)!;
    expect(failed).toMatchObject({
      historical: true, mpnRecord: false, mpn_canonical: NO_RECORD_FAILED, mpn_display: NO_RECORD_FAILED, bomMpnDisplay: NO_RECORD_FAILED,
      description: "", new_price_min: null, models: 0, donors: 0, state: "failed", disposition: null,
      suspect: false, qualification: null, market: "missing", diagram_id: ""
    });
    expect(failed.removal.minutes).toBeNull();
    expect(failed.partToken).toBeTruthy();
    // A catalogued historical part on the same machine still follows the machine's suspect families.
    expect(parts.get(CATALOGUED)!.suspect).toBe(true);
    const { byMpn, header } = await exportCsv("41");
    expect(byMpn.get(NO_RECORD_FAILED)![header.indexOf("Test First")]).toBe("");
  });

  it("shows an unrecorded historical state beside a found parts list, after the current parts", async () => {
    const detail = (await machineDetail(db, "44"))!;
    expect(detail.parts.map((p) => [p.mpn_canonical, p.historical, p.mpnRecord])).toEqual([
      [CURRENT, false, true], [NO_RECORD_FAILED, true, false]
    ]);
    const { description } = await exportCsv("44");
    expect(description(CURRENT)).toBe(`Fixture part ${CURRENT}`);
    expect(description(NO_RECORD_FAILED)).toBe(HISTORICAL_DESCRIPTION_MARKER);
  });

  it("creates no MPN record, model edge or donor stock, and keeps states, sales and repairs as recorded", async () => {
    expect(await db.select().from(schema.mpnMaster).where(inArray(schema.mpnMaster.mpnCanonical, NO_RECORD))).toEqual([]);
    expect(await db.select().from(schema.modelPartEdges).where(inArray(schema.modelPartEdges.mpnCanonical, [...NO_RECORD, CATALOGUED])))
      .toEqual([expect.objectContaining({ modelKey: "GTD81ESSJ2WS", mpnCanonical: CATALOGUED })]);
    for (const mpn of NO_RECORD) expect(await mpnDetail(db, mpn, "eligible")).toBeNull();
    // CATALOGUED is listed only on a model with no fleet machines; machine 41's history adds no donor.
    expect((await mpnDetail(db, CATALOGUED, "eligible"))!.mpn).toMatchObject({ models: 1, donors: 0 });
    // The untouched machine of 44's model counts for its current part; 44's unrecorded state adds nothing to 45.
    expect((await mpnDetail(db, CURRENT, "eligible"))!.mpn.donors).toBe(2);
    expect((await machineDetail(db, "45"))!.parts.map((p) => p.mpn_canonical)).toEqual([CURRENT]);

    const states = await db.select().from(schema.machinePartState);
    expect(states.map((s) => [s.machineNo, s.mpnCanonical, s.state, s.disposition, s.soldPrice, s.repairMachineNo]).sort()).toEqual([
      ["41", CATALOGUED, "pulled", "sold", "25.00", null],
      ["41", NO_RECORD_FAILED, "failed", null, null, null],
      ["41", NO_RECORD_REPAIR, "pulled", "repair", null, "44"],
      ["42", NO_RECORD_SOLD, "pulled", "sold", "12.50", null],
      ["44", NO_RECORD_FAILED, "failed", null, null, null]
    ].sort());
    const sales = await partDispositionHistory(db, "42");
    expect(sales.some((e) => e.mpn_canonical === NO_RECORD_SOLD && e.step === "sold" && e.sold_price === "12.50")).toBe(true);
  });
});
