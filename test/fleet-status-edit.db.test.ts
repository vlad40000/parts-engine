import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  bomQueue, fleetSummary, getSettings, listFleet, mpnDetail, machineDetail,
  updateMachineModel, updateMachineStatus, upsertFleet
} from "@/src/db/queries";
import { FLEET_STATUS_OPTIONS, isEditableFleetStatus } from "@/src/lib/fleet-status";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { updateMachineStatusAction } from "@/app/actions";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let db: Db;
const row = (ID: number, Availability: string, ModelNumber = "OLD100") => ({
  ID, Availability, ApplianceType: "Washer", Brand: "Whirlpool",
  ModelNumber, SerialNumber: "CS2412345"
});
const edit = (machineNo: string, status: string, expectedStatus = "PARTS ONLY") =>
  updateMachineStatus(db, { machineNo, status, expectedStatus });
const events = () => db.select().from(schema.fleetStatusEvents).orderBy(schema.fleetStatusEvents.id);

beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    row(1, "PARTS ONLY"), row(2, "PARTS ONLY"),
    row(3, "PARTS ONLY", "RETRY500"), row(4, "UNCHECKED", "RETRY500")
  ]).rows);
  await db.insert(schema.modelBomCache).values([
    { brandKey: "WHIRLPOOL", modelKey: "OLD100", brandDisplay: "Whirlpool", modelDisplay: "OLD100", status: "found", rowCount: 1 },
    { brandKey: "WHIRLPOOL", modelKey: "RETRY500", brandDisplay: "Whirlpool", modelDisplay: "RETRY500", status: "error", rowCount: 0 }
  ]);
  await db.insert(schema.mpnMaster).values({ mpnCanonical: "OLDPART", mpnDisplay: "OLDPART" });
  await db.insert(schema.modelPartEdges).values({ brandKey: "WHIRLPOOL", modelKey: "OLD100", mpnCanonical: "OLDPART", mpnDisplay: "OLDPART", source: "test" });
});

describe("editable machine statuses", () => {
  it("enforces controlled options and retains historic SCRAPED as non-editable", () => {
    expect(FLEET_STATUS_OPTIONS).toContain("SCRAPPED");
    expect(FLEET_STATUS_OPTIONS).toContain("SOLD");
    expect(isEditableFleetStatus("SCRAPED")).toBe(false);
    expect(isEditableFleetStatus("SOLD ")).toBe(false);
    expect(isEditableFleetStatus("some unknown status")).toBe(false);
  });

  it("saves status per machine, writes one audit event and removes off-lot donor immediately", async () => {
    expect((await mpnDetail(db, "OLDPART", "eligible"))?.machines.map(m => m.machine_no)).toEqual(["1","2"]);
    expect(await edit("1", "SOLD")).toBe("saved");
    const one = (await machineDetail(db, "1"))!.machine;
    expect(one).toMatchObject({ availability: "SOLD", statusOverride: true, modelRaw: "OLD100" });
    expect((await machineDetail(db, "2"))!.machine.availability).toBe("PARTS ONLY");
    expect((await listFleet(db, { availability: "SOLD" })).rows.map(m => m.machine_no)).toEqual(["1"]);
    expect((await mpnDetail(db, "OLDPART", "eligible"))!.machines.map(m => m.machine_no)).toEqual(["2"]);
    expect((await fleetSummary(db)).offLot).toBe(1);
    expect((await events()).map(({ machineNo, previousStatus, nextStatus, source }) => ({ machineNo, previousStatus, nextStatus, source })))
      .toEqual([{ machineNo: "1", previousStatus: "PARTS ONLY", nextStatus: "SOLD", source: "fleet_ui" }]);
  });

  it("drops a newly scrapped donor from the retry queue without erasing cached evidence", async () => {
    const eligible = (await getSettings(db)).donorAvailabilities;
    expect((await bomQueue(db, { availability: "PARTS ONLY", queue: "retry" }, eligible)).totalMachines).toBe(1);
    expect(await edit("3", "SCRAPPED")).toBe("saved");
    expect((await bomQueue(db, { availability: "PARTS ONLY", queue: "retry" }, eligible)).totalMachines).toBe(0);
    expect((await db.select().from(schema.modelBomCache)).length).toBe(2);
    expect((await db.select().from(schema.modelPartEdges)).length).toBe(1);
  });

  it("protects the edited status on reimport while other imported fields still refresh", async () => {
    expect(await edit("1", "SOLD")).toBe("saved");
    await upsertFleet(db, mapFleetRows([
      { ...row(1, "PARTS ONLY"), Condition: "new inspection" },
      row(2, "READY TO SALE"),
      row(4, "SCRAPPED", "RETRY500")
    ]).rows);
    const [one] = await db.select().from(schema.fleetMachines).where(eq(schema.fleetMachines.machineNo,"1"));
    const [two] = await db.select().from(schema.fleetMachines).where(eq(schema.fleetMachines.machineNo,"2"));
    expect(one).toMatchObject({ availability: "SOLD", condition: "new inspection", statusOverride: true });
    expect(two).toMatchObject({ availability: "READY TO SALE", statusOverride: false });
    expect((await machineDetail(db,"4"))?.machine.availability).toBe("SCRAPPED");
  });

  it("keeps separate manual model and status overrides intact through reimports", async () => {
    expect(await updateMachineModel(db, {
      machineNo: "1", expectedModel: "OLD100", expectedBrand: "Whirlpool",
      expectedSerial: "CS2412345", model: "CHANGED700"
    })).toBe("saved");
    expect(await edit("1", "SOLD")).toBe("saved");
    await upsertFleet(db, mapFleetRows([{ ...row(1,"PARTS ONLY"), ModelNumber: "OLD100", SerialNumber:"WRONG" }]).rows);
    expect((await machineDetail(db,"1"))?.machine).toMatchObject({
      availability: "SOLD", modelRaw: "CHANGED700", serial: "CS2412345", source: "manual_model", statusOverride: true
    });
  });

  it("rejects tampered and stale edits with no change or audit event", async () => {
    expect(await edit("1", "READY FOR TEST")).toBe("invalid");
    expect(await edit("1", "scrapped")).toBe("invalid");
    expect(await edit("999", "SOLD")).toBe("not_found");
    expect(await edit("1", "SOLD", "UNCHECKED")).toBe("conflict");
    expect(await edit("1", "PARTS ONLY")).toBe("unchanged");
    expect((await events())).toHaveLength(0);
    expect((await machineDetail(db,"1"))?.machine.statusOverride).toBe(false);
  });

  it("supports a recorded reversal from SOLD back to checked stock", async () => {
    expect(await edit("1", "SOLD")).toBe("saved");
    expect(await edit("1", "PARTS ONLY", "SOLD")).toBe("saved");
    expect((await events()).map(e => [e.previousStatus,e.nextStatus])).toEqual([
      ["PARTS ONLY","SOLD"], ["SOLD","PARTS ONLY"]
    ]);
    expect((await mpnDetail(db, "OLDPART", "eligible"))?.machines.map(m => m.machine_no)).toEqual(["1","2"]);
  });

  it("uses the same verified server action as the Fleet dropdown", async () => {
    const f = new FormData();
    for (const [key,value] of Object.entries({machineNo:"3",expectedStatus:"PARTS ONLY",status:"SOLD"})) f.set(key,value);
    expect(await updateMachineStatusAction(null,f)).toMatchObject({ok:true});
    expect((await events())).toHaveLength(1);
    expect((await machineDetail(db,"3"))?.machine.availability).toBe("SOLD");
    const rejected = await updateMachineStatusAction(null,f);
    expect(rejected).toMatchObject({ok:false});
    expect((await events())).toHaveLength(1);
  });
});
