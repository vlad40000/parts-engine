import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  machineDetail, partDispositionHistory, saveModelBom, setPartDisposition, setPartState, upsertFleet
} from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { parseCsvRows } from "@/src/lib/csv";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { GET } from "@/app/api/export/machine-parts/[id]/route";
import { readQuery } from "../scripts/fleet-audit/run";
import type { HistoryRow } from "../scripts/fleet-audit/report";

/**
 * CHARACTERIZATION of a known gap (docs/FLEET_APPLICABILITY_AUDIT.md, "Historical parts visibility").
 *
 * A found parts-list refresh replaces every model edge. machineDetail() and the per-machine CSV both start from
 * model_part_edges, so a pulled/sold or failed part whose MPN is absent from the refreshed list keeps its stored
 * state but disappears from the parts list and the export. Only the dated disposition events stay on the page.
 *
 * These expectations pin today's behaviour so the gap cannot be misreported either way. The slice that makes
 * historical parts visible must flip the "hidden" assertions below; the storage assertions must keep passing.
 */
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));

let db: Db;
let client: PGlite;
const SOLD = "WE99X00001";
const FAILED = "WE99X00002";
const KEPT = "WE99X00003";
const ADDED = "WE99X00004";
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
  return rows.map((r) => r[header.indexOf("MPN")]);
};

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    { ID: 21, Brand: "GE", ModelNumber: "GTD42EASJ2WW", SerialNumber: "FIXTURE-21", Availability: "PARTS ONLY", ApplianceType: "Dryer" }
  ]).rows);
  await saveList([SOLD, FAILED, KEPT]);
  await setPartState(db, "21", SOLD, "pulled");
  expect(await setPartDisposition(db, { machineNo: "21", mpnCanonical: SOLD, from: null, step: "ebay" })).toBe("saved");
  expect(await setPartDisposition(db, { machineNo: "21", mpnCanonical: SOLD, from: "ebay", step: "sold", soldPrice: "19.00" })).toBe("saved");
  await setPartState(db, "21", FAILED, "failed");
}, 30000);

describe("historical part state after a parts-list refresh (current behaviour)", () => {
  it("shows the sold and failed parts while their MPNs are on the current list", async () => {
    const before = await machineDetail(db, "21");
    const byMpn = new Map(before!.parts.map((p) => [p.mpn_canonical, p]));
    expect(byMpn.get(SOLD)).toMatchObject({ state: "pulled", disposition: "sold", soldPrice: "19.00" });
    expect(byMpn.get(FAILED)).toMatchObject({ state: "failed" });
    expect(await exportCsv("21")).toEqual(expect.arrayContaining([SOLD, FAILED, KEPT]));
  });

  it("keeps the stored states but hides them from the parts list and CSV once a refresh drops the MPNs", async () => {
    await saveList([KEPT, ADDED]);

    // Storage survives the refresh: nothing about the harvested or failed part is deleted.
    const states = await db.select().from(schema.machinePartState);
    expect(states.map((s) => [s.mpnCanonical, s.state, s.disposition, s.soldPrice]).sort()).toEqual([
      [SOLD, "pulled", "sold", "19.00"], [FAILED, "failed", null, null]
    ].sort());

    // GAP: the parts list and the shop-floor CSV read only current edges.
    const after = await machineDetail(db, "21");
    expect(after!.parts.map((p) => p.mpn_canonical).sort()).toEqual([KEPT, ADDED].sort());
    expect(await exportCsv("21")).toEqual(expect.not.arrayContaining([SOLD]));
    expect(await exportCsv("21")).toEqual(expect.not.arrayContaining([FAILED]));

    // The dated disposition events are read by machine, not by edge, so the sale stays visible there.
    // The failed part has no disposition events, so nothing on the page shows it any more.
    const events = await partDispositionHistory(db, "21");
    expect(events.map((e) => [e.mpn_canonical, e.step, e.sold_price])).toEqual([[SOLD, "sold", "19.00"], [SOLD, "ebay", null]]);
    expect(events.some((e) => e.mpn_canonical === FAILED)).toBe(false);
  });

  it("is found by the fleet audit history query, which starts from state and event tables", async () => {
    const rows = (await client.query<HistoryRow>(await readQuery("history"))).rows;
    const unmatched = rows.filter((r) => r.edge_match === "unmatched historical MPN");
    expect(unmatched.map((r) => [r.mpn_canonical, r.origin, r.action]).sort()).toEqual([
      [FAILED, "state", "failed"], [SOLD, "disposition", "ebay"], [SOLD, "disposition", "sold"], [SOLD, "state", "pulled"]
    ].sort());
    expect(rows.filter((r) => r.mpn_canonical === KEPT)).toEqual([]);
  });
});
