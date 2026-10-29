import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { listFleet, machineDetail, mpnDetail, updateMachineLocation, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { updateMachineLocationAction } from "@/app/actions";
import { GET as exportDonors } from "@/app/api/export/mpn-donors/route";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
let db: Db;
const row = (ID: number, Location?: string) => ({
  ID, Brand: "Whirlpool", ModelNumber: "MODEL100", SerialNumber: "CS2412345",
  Availability: "PARTS ONLY", ApplianceType: "Washer", ...(Location === undefined ? {} : { Location })
});
beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([row(1, "YARD-A3"), row(2, "RACK-B2"), row(3)]).rows);
});

describe("physical machine locations", () => {
  it("supports location search, a dedicated filter and A–Z / Z–A sorting with pagination", async () => {
    expect((await listFleet(db, { q: "yard-a3" })).rows.map(m => m.machine_no)).toEqual(["1"]);
    expect((await listFleet(db, { location: "rack" })).rows.map(m => m.machine_no)).toEqual(["2"]);
    expect((await listFleet(db, { sort: "location_asc" })).rows.map(m => m.machine_no)).toEqual(["2", "1", "3"]);
    expect((await listFleet(db, { sort: "location_desc" })).rows.map(m => m.machine_no)).toEqual(["1", "2", "3"]);
    expect((await listFleet(db, { sort: "location_asc" }, 1, 1)).rows[0].machine_no).toBe("1");
  });

  it("preserves a manual move on re-import and keeps imported placement if a later sheet omits location", async () => {
    expect(await updateMachineLocation(db, { machineNo: "1", expectedLocation: "YARD-A3", location: "ROW-04" })).toBe("saved");
    await upsertFleet(db, mapFleetRows([row(1, "OLD-IMPORT"), row(2)]).rows);
    expect((await machineDetail(db, "1"))?.machine).toMatchObject({ location: "ROW-04", locationOverride: true });
    expect((await machineDetail(db, "2"))?.machine).toMatchObject({ location: "RACK-B2", locationOverride: false });
    await upsertFleet(db, mapFleetRows([row(2, "BAY-07")]).rows);
    expect((await machineDetail(db, "2"))?.machine.location).toBe("BAY-07");
  });

  it("rejects stale/invalid edits and explicitly clears a location without import resurrection", async () => {
    expect(await updateMachineLocation(db, { machineNo: "1", expectedLocation: "wrong", location: "BAY-07" })).toBe("conflict");
    expect(await updateMachineLocation(db, { machineNo: "1", expectedLocation: "YARD-A3", location: "X".repeat(121) })).toBe("invalid");
    expect(await updateMachineLocation(db, { machineNo: "999", expectedLocation: "", location: "X" })).toBe("not_found");
    expect(await updateMachineLocation(db, { machineNo: "1", expectedLocation: "YARD-A3", location: "   " })).toBe("saved");
    await upsertFleet(db, mapFleetRows([row(1, "YARD-A3")]).rows);
    expect((await machineDetail(db, "1"))?.machine).toMatchObject({ location: null, locationOverride: true });
  });

  it("propagates the current donor machine location to MPN cross-reference and CSV export", async () => {
    await db.insert(schema.mpnMaster).values({ mpnCanonical: "TESTPART", mpnDisplay: "TESTPART" });
    await db.insert(schema.modelPartEdges).values({
      brandKey: "WHIRLPOOL", modelKey: "MODEL100", mpnCanonical: "TESTPART",
      mpnDisplay: "TESTPART", source: "test"
    });
    expect((await mpnDetail(db, "TESTPART", "eligible"))?.machines.find(m => m.machine_no === "1")?.location).toBe("YARD-A3");
    await updateMachineLocation(db, { machineNo: "1", expectedLocation: "YARD-A3", location: "BAY-09" });
    const csv = await (await exportDonors(new Request("http://local/api/export/mpn-donors?mpn=TESTPART"))).text();
    expect(csv).toContain("location");
    expect(csv).toContain("BAY-09");
  });

  it("saves through the production server action and detects stale retries", async () => {
    const f = new FormData();
    for (const [k,v] of Object.entries({ machineNo: "1", expectedLocation: "YARD-A3", location: "WAREHOUSE-B2" })) f.set(k,v);
    expect(await updateMachineLocationAction(null, f)).toMatchObject({ ok: true });
    expect((await machineDetail(db, "1"))?.machine.location).toBe("WAREHOUSE-B2");
    expect((await updateMachineLocationAction(null, f)).ok).toBe(false);
  });
});
