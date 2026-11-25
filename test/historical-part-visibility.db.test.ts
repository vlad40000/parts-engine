import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  machineDetail, mpnDetail, partDispositionHistory, saveModelBom, setPartDisposition, setPartState, setPartStateFromPage, upsertFleet
} from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { parseCsvRows } from "@/src/lib/csv";
import { HISTORICAL_DESCRIPTION_MARKER } from "@/src/lib/machine-parts-export";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { GET } from "@/app/api/export/machine-parts/[id]/route";
import { readQuery } from "../scripts/fleet-audit/run";
import type { HistoryRow } from "../scripts/fleet-audit/report";

/**
 * Historical parts visibility (docs/FLEET_APPLICABILITY_AUDIT.md, "Historical parts visibility").
 *
 * A found parts-list refresh replaces every model edge. A part whose state was recorded on the machine (pulled,
 * eBay, listed, sold, repair, failed) must stay on the machine page and in the per-machine CSV even when the
 * refreshed list no longer includes its MPN. It is marked historical, never counted as donor stock, and a
 * cleared or Unlisted part (state row deleted) is not brought back.
 */
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));

let db: Db;
let client: PGlite;
const SOLD = "WE99X00001";
const FAILED = "WE99X00002";
const KEPT = "WE99X00003";
const ADDED = "WE99X00004";
const LISTED = "WE99X00005";
const REPAIR = "WE99X00006";
const PULLED = "WE99X00007";
const UNLISTED = "WE99X00008";
const CLEARED = "WE99X00009";
const DROPPED = [SOLD, FAILED, LISTED, REPAIR, PULLED, UNLISTED, CLEARED];
const row = (mpn: string): SupplierRow => ({
  mpnDisplay: mpn, mpnCanonical: mpn, description: `Fixture part ${mpn}`, diagramId: "01 - Fixture Section",
  supplierPartId: null, newPrice: 10, nla: false
});
const found = (mpns: string[]): ChainResult => ({
  status: "found",
  winner: {
    supplier: "appliancepartspros", status: "found", rows: mpns.map(row), droppedRows: 0,
    sourceUrl: "https://supplier.test/model", visited: [], warnings: [], elapsedMs: 1
  },
  attempts: []
});
const saveList = (mpns: string[]) => saveModelBom(db, {
  brandKey: "GE", modelKey: "GTD42EASJ2WW", brandDisplay: "GE", modelDisplay: "GTD42EASJ2WW", result: found(mpns)
});
const exportCsv = async (id: string) => {
  const response = await GET(new Request(`http://localhost/api/export/machine-parts/${id}`), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  const [header, ...rows] = parseCsvRows(await response.text());
  return { header, rows, mpns: rows.map((r) => r[header.indexOf("MPN")]) };
};
const step = async (mpnCanonical: string, from: "ebay" | "listed" | null, next: "ebay" | "listed" | "sold" | "repair" | "unlisted",
  extra: { soldPrice?: string; repairMachineNo?: string } = {}) =>
  expect(await setPartDisposition(db, { machineNo: "21", mpnCanonical, from, step: next, ...extra })).toBe("saved");
const parts = async () => new Map((await machineDetail(db, "21"))!.parts.map((p) => [p.mpn_canonical, p]));

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    { ID: 21, Brand: "GE", ModelNumber: "GTD42EASJ2WW", SerialNumber: "FIXTURE-21", Availability: "PARTS ONLY", ApplianceType: "Dryer" },
    { ID: 22, Brand: "GE", ModelNumber: "GTD42EASJ2WW", SerialNumber: "FIXTURE-22", Availability: "PARTS ONLY", ApplianceType: "Dryer" }
  ]).rows);
  await saveList([...DROPPED, KEPT]);
  for (const mpn of [SOLD, LISTED, REPAIR, PULLED, UNLISTED]) await setPartState(db, "21", mpn, "pulled");
  await step(SOLD, null, "ebay");
  await step(SOLD, "ebay", "sold", { soldPrice: "19.00" });
  await step(LISTED, null, "ebay");
  await step(LISTED, "ebay", "listed");
  await step(REPAIR, null, "repair", { repairMachineNo: "22" });
  await setPartState(db, "21", FAILED, "failed");
  // Cleared before the refresh: a failed mark that was undone, and a listed part that was Unlisted.
  await setPartState(db, "21", CLEARED, "failed");
  await setPartState(db, "21", CLEARED, null);
  await step(UNLISTED, null, "ebay");
  await step(UNLISTED, "ebay", "listed");
  await step(UNLISTED, "listed", "unlisted");
}, 30000);

describe("historical part state after a parts-list refresh", () => {
  it("shows every recorded part while its MPN is on the current list", async () => {
    const before = await parts();
    expect(before.get(SOLD)).toMatchObject({ historical: false, state: "pulled", disposition: "sold", soldPrice: "19.00" });
    expect(before.get(FAILED)).toMatchObject({ historical: false, state: "failed" });
    expect((await exportCsv("21")).mpns).toEqual(expect.arrayContaining([...DROPPED, KEPT]));
  });

  it("keeps sold, listed, repair, pulled and failed parts on the machine page once a refresh drops their MPNs", async () => {
    await saveList([KEPT, ADDED]);

    // Storage survives the refresh: nothing about the recorded parts is deleted.
    const states = await db.select().from(schema.machinePartState);
    expect(states.map((s) => [s.mpnCanonical, s.state, s.disposition, s.soldPrice, s.repairMachineNo]).sort()).toEqual([
      [SOLD, "pulled", "sold", "19.00", null], [LISTED, "pulled", "listed", null, null], [REPAIR, "pulled", "repair", null, "22"],
      [PULLED, "pulled", null, null, null], [FAILED, "failed", null, null, null]
    ].sort());

    const detail = (await machineDetail(db, "21"))!;
    const after = new Map(detail.parts.map((p) => [p.mpn_canonical, p]));
    expect(after.get(SOLD)).toMatchObject({ historical: true, state: "pulled", disposition: "sold", soldPrice: "19.00", mpn_display: SOLD });
    expect(after.get(LISTED)).toMatchObject({ historical: true, state: "pulled", disposition: "listed", wasListed: true });
    expect(after.get(REPAIR)).toMatchObject({ historical: true, state: "pulled", disposition: "repair", repairMachineNo: "22" });
    expect(after.get(PULLED)).toMatchObject({ historical: true, state: "pulled", disposition: null });
    expect(after.get(FAILED)).toMatchObject({ historical: true, state: "failed" });
    // The row version is carried, so the page's state and disposition controls keep their stale-tab guard.
    expect(after.get(FAILED)!.partToken).toBeTruthy();
    expect(after.get(KEPT)).toMatchObject({ historical: false, state: null });
    expect(after.get(ADDED)).toMatchObject({ historical: false, state: null });

    // Cleared and Unlisted parts are not resurrected.
    expect(after.has(CLEARED)).toBe(false);
    expect(after.has(UNLISTED)).toBe(false);

    // Each part appears once; current-list parts first, historical parts after.
    expect(detail.parts).toHaveLength(after.size);
    const firstHistorical = detail.parts.findIndex((p) => p.historical);
    expect(detail.parts.slice(0, firstHistorical).map((p) => p.mpn_canonical).sort()).toEqual([ADDED, KEPT].sort());
    expect(detail.parts.slice(firstHistorical).every((p) => p.historical)).toBe(true);
  });

  it("keeps the simplified CSV format and lists historical parts in it, marked historical", async () => {
    const { header, rows, mpns } = await exportCsv("21");
    expect(header).toEqual([
      "Machine ID", "Brand", "Model", "Serial", "Physical Location",
      "MPN", "Description", "Test First", "Removal Minutes"
    ]);
    expect(rows.every((r) => r.length === 9)).toBe(true);
    expect([...mpns].sort()).toEqual([KEPT, ADDED, SOLD, LISTED, REPAIR, PULLED, FAILED].sort());
    const sold = rows.find((r) => r[header.indexOf("MPN")] === SOLD)!;
    expect(sold[header.indexOf("Machine ID")]).toBe("21");
    // Historical rows are marked in Description; current rows and the stored description are unchanged.
    const description = (mpn: string) => rows.find((r) => r[header.indexOf("MPN")] === mpn)![header.indexOf("Description")];
    for (const mpn of [SOLD, LISTED, REPAIR, PULLED, FAILED]) {
      expect(description(mpn)).toBe(`${HISTORICAL_DESCRIPTION_MARKER} Fixture part ${mpn}`);
    }
    for (const mpn of [KEPT, ADDED]) expect(description(mpn)).toBe(`Fixture part ${mpn}`);
    expect((await mpnDetail(db, SOLD))!.mpn.description).toBe(`Fixture part ${SOLD}`);
    expect((await parts()).get(SOLD)!.description).toBe(`Fixture part ${SOLD}`);
  });

  it("never counts historical-only parts as donor stock", async () => {
    for (const mpn of DROPPED) {
      const d = (await mpnDetail(db, mpn, "eligible"))!;
      expect(d.mpn).toMatchObject({ models: 0, donors: 0 });
      expect(d.machines).toEqual([]);
      expect(d.harvest.counts).toMatchObject({ harvestCandidates: 0, testFirst: 0, unavailable: 0 });
    }
    // A current part still counts both untouched machines of the model.
    expect((await mpnDetail(db, KEPT, "eligible"))!.mpn.donors).toBe(2);
    // Machine 21's historical parts add nothing to machine 22.
    expect((await machineDetail(db, "22"))!.parts.map((p) => p.mpn_canonical).sort()).toEqual([ADDED, KEPT].sort());
  });

  it("drops a historical part once its state is cleared, and does not bring it back on the next refresh", async () => {
    const failed = (await parts()).get(FAILED)!;
    expect(await setPartStateFromPage(db, { machineNo: "21", mpnCanonical: FAILED, state: null, expectedState: "failed", token: failed.partToken })).toBe("saved");
    await step(LISTED, "listed", "unlisted");
    await saveList([KEPT, ADDED]);
    const after = await parts();
    expect(after.has(FAILED)).toBe(false);
    expect(after.has(LISTED)).toBe(false);
    expect((await exportCsv("21")).mpns).toEqual(expect.not.arrayContaining([FAILED]));
    expect((await exportCsv("21")).mpns).toEqual(expect.not.arrayContaining([LISTED]));
    // The dated disposition history still records the sale and the Unlisted step.
    const events = await partDispositionHistory(db, "21");
    expect(events.some((e) => e.mpn_canonical === SOLD && e.step === "sold" && e.sold_price === "19.00")).toBe(true);
    expect(events.some((e) => e.mpn_canonical === LISTED && e.step === "unlisted")).toBe(true);
  });

  it("returns a historical part to the current list, state intact, when a refresh lists its MPN again", async () => {
    await saveList([KEPT, ADDED, SOLD]);
    expect((await parts()).get(SOLD)).toMatchObject({ historical: false, state: "pulled", disposition: "sold", soldPrice: "19.00" });
  });

  it("is still found by the fleet audit history query, which starts from state and event tables", async () => {
    await saveList([KEPT, ADDED]);
    const rows = (await client.query<HistoryRow>(await readQuery("history"))).rows;
    const unmatched = rows.filter((r) => r.edge_match === "unmatched historical MPN" && r.origin === "state");
    expect(unmatched.map((r) => [r.mpn_canonical, r.action]).sort()).toEqual([
      [SOLD, "pulled"], [REPAIR, "pulled"], [PULLED, "pulled"]
    ].sort());
    expect(rows.filter((r) => r.mpn_canonical === KEPT)).toEqual([]);
  });
});
