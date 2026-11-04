import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { machineDetail, updateMachineStatus, upsertFleet } from "@/src/db/queries";
import { verifyMachineReturn } from "@/src/db/fleet-return";
import { createTechNote, pendingFleetReview, machineHistory } from "@/src/db/tech-notes";
import { normalizeReading } from "@/src/lib/tech-notes/reading";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { verifyMachineReturnAction } from "@/app/actions";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
let db: Db;
const sourceRow = (status = "SOLD", location = "$$$SOLD$$$") => ({
  ID: 5576, Availability: status, Location: location, Condition: "B - Good",
  ApplianceType: "Freezer", Brand: "Whirlpool", ModelNumber: "FREEZER5576", SerialNumber: "SER5576"
});
const submission = (fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    machineNo: "5576", expectedStatus: "SOLD", expectedLocation: "$$$SOLD$$$",
    status: "NEEDS PARTS", locationChoice: "Red Building", physicallyVerified: "yes", ...fields
  })) form.set(key, value);
  return form;
};

beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([sourceRow()]).rows);
  await createTechNote(db, { origin: "manual", reading: normalizeReading({
    date: { text: "3/24/26" }, entries: [{
      machine: { text: "5576" }, status: { checked: "READY TO SALE" },
      location: { name: "Showroom - Main" }, note: "Observed before or after sale; unknown."
    }]
  }) });
});

describe("one-step physical return verification", () => {
  it("atomically updates status, location and condition, logs both, and preserves the photo note", async () => {
    expect((await pendingFleetReview(db)).returnMachineCounts).toEqual({ "5576": 1 });
    expect(await verifyMachineReturnAction(null, submission())).toMatchObject({ ok: true });
    expect((await machineDetail(db, "5576"))!.machine).toMatchObject({
      availability: "NEEDS PARTS", location: "Red Building", condition: "E - Needs Parts",
      statusOverride: true, locationOverride: true
    });
    expect(await db.select().from(schema.fleetStatusEvents)).toEqual([
      expect.objectContaining({
        machineNo: "5576", previousStatus: "SOLD", nextStatus: "NEEDS PARTS", source: "return_verified"
      })
    ]);
    const events = await db.select().from(schema.fleetFieldEvents);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "location", previousValue: "$$$SOLD$$$", nextValue: "Red Building", source: "return_verified" }),
      expect.objectContaining({ field: "condition", previousValue: "B - Good", nextValue: "E - Needs Parts", source: "return_verified" })
    ]));
    expect(events).toHaveLength(2);
    const history = await machineHistory(db, "5576");
    expect(history.some((e) => e.field === "status" && e.source === "return_verified")).toBe(true);
    expect(history.some((e) => e.field === "location" && e.source === "return_verified")).toBe(true);
    expect((await pendingFleetReview(db)).returnMachineCounts).toEqual({});
    expect((await db.select().from(schema.techNotes))).toMatchObject([{ status: "open" }]);
    // Import cannot silently resurrect the SOLD marker.
    await upsertFleet(db, mapFleetRows([sourceRow()]).rows);
    expect((await machineDetail(db, "5576"))!.machine).toMatchObject({
      availability: "NEEDS PARTS", location: "Red Building"
    });
  });

  it("rejects stale retries, unchecked physical verification, invalid inputs without partial writes", async () => {
    expect((await verifyMachineReturnAction(null, submission({ physicallyVerified: "no" }))).ok).toBe(false);
    expect((await verifyMachineReturnAction(null, submission({ status: "SOLD" }))).ok).toBe(false);
    expect((await verifyMachineReturnAction(null, submission({ locationChoice: "__other", locationOther: "$$$SOLD$$$" }))).ok).toBe(false);
    expect((await verifyMachineReturnAction(null, submission({ expectedLocation: "Shop" }))).ok).toBe(false);
    expect(await db.select().from(schema.fleetStatusEvents)).toHaveLength(0);
    expect(await db.select().from(schema.fleetFieldEvents)).toHaveLength(0);
    expect(await verifyMachineReturnAction(null, submission())).toMatchObject({ ok: true });
    expect((await verifyMachineReturnAction(null, submission())).ok).toBe(false);
    expect(await db.select().from(schema.fleetStatusEvents)).toHaveLength(1);
    expect((await machineDetail(db, "5576"))!.machine).toMatchObject({
      availability: "NEEDS PARTS", location: "Red Building"
    });
  });

  it("supports a pre-edited status with stale SOLD location and records status confirmation", async () => {
    expect(await updateMachineStatus(db, { machineNo: "5576", expectedStatus: "SOLD", status: "PARTS ONLY" }))
      .toBe("saved");
    expect((await pendingFleetReview(db)).returnMachineCounts).toEqual({ "5576": 1 });
    const result = await verifyMachineReturn(db, {
      machineNo: "5576", expectedStatus: "PARTS ONLY", expectedLocation: "$$$SOLD$$$",
      status: "PARTS ONLY", location: "Shop"
    });
    expect(result).toBe("verified");
    const events = await db.select().from(schema.fleetFieldEvents);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "status", previousValue: "PARTS ONLY", nextValue: "PARTS ONLY", confirmation: true, source: "return_verified" }),
      expect.objectContaining({ field: "location", previousValue: "$$$SOLD$$$", nextValue: "Shop", confirmation: false, source: "return_verified" })
    ]));
    expect((await pendingFleetReview(db)).returnMachineCounts).toEqual({});
  });

  it("resolves existing VERIFY LOCATION checks as part of the same physical inspection", async () => {
    await db.insert(schema.fleetLocationChecks).values({
      machineNo: "5576", previousLocation: "$$$SOLD$$$", recordedLocation: "Shop",
      observedAt: new Date("2026-03-24T12:00:00Z")
    });
    expect(await verifyMachineReturnAction(null, submission())).toMatchObject({ ok: true });
    const checks = await db.select().from(schema.fleetLocationChecks);
    expect(checks).toMatchObject([{ resolvedLocation: "Red Building" }]);
    expect(checks[0].resolvedAt).not.toBeNull();
  });
});
