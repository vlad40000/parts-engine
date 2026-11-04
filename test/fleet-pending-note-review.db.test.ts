import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { upsertFleet, updateMachineLocation, updateMachineStatus } from "@/src/db/queries";
import { createTechNote, pendingFleetReview, pendingMachineNotes } from "@/src/db/tech-notes";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { normalizeReading } from "@/src/lib/tech-notes/reading";

let db: Db;
beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    { ID: 7771, Availability: "UNCHECKED", ApplianceType: "Dryer", Brand: "Test", ModelNumber: "DRY7771", SerialNumber: "SER7771", Location: "Warehouse" },
    { ID: 7772, Availability: "PARTS ONLY", ApplianceType: "Microwave", Brand: "Test", ModelNumber: "MIC7772", SerialNumber: "SER7772", Location: "Graveyard" }
  ], new Date("2026-05-01T12:00:00Z")).rows);
});

describe("Fleet pending service note alerts", () => {
  it("counts one multi-machine note once, but flags each known machine", async () => {
    const reading = normalizeReading({
      date: { text: "4/21/26" },
      entries: [
        { machine: { text: "7771" }, status: { checked: "PARTS ONLY" }, location: { name: "Graveyard" } },
        { machine: { text: "7772" }, status: { checked: "READY TO SALE" }, location: { name: "Showroom - Main" } }
      ]
    });
    const noteId = await createTechNote(db, { origin: "manual", reading });
    const first = await pendingMachineNotes(db, "7771");
    const second = await pendingMachineNotes(db, "7772");
    expect(first).toMatchObject([{ id: noteId, written: "4/21/26", status: "PARTS ONLY", location: "Graveyard" }]);
    // Regression: the second machine must never display the first one's status/location.
    expect(second).toMatchObject([{ id: noteId, status: "READY TO SALE", location: "Showroom - Main" }]);
    expect(await pendingFleetReview(db)).toEqual({ noteCount: 1, machineCounts: { "7771": 1, "7772": 1 }, returnMachineCounts: {} });
  });

  it("keeps an unidentified photo in the queue and removes alerts after review is closed", async () => {
    const found = await createTechNote(db, { origin: "manual", reading: normalizeReading({
      entries: [{ machine: { text: "7771" } }, { machine: { text: "7771" } }]
    }) });
    const unknown = await createTechNote(db, { origin: "manual", reading: normalizeReading({
      entries: [{ machine: { text: "" } }]
    }) });
    expect(await pendingFleetReview(db)).toEqual({ noteCount: 2, machineCounts: { "7771": 1 }, returnMachineCounts: {} });
    await db.execute(sql`update tech_notes set status = 'discarded' where id = ${found}::uuid`);
    expect(await pendingMachineNotes(db, "7771")).toEqual([]);
    expect(await pendingFleetReview(db)).toEqual({ noteCount: 1, machineCounts: {}, returnMachineCounts: {} });
    await db.execute(sql`update tech_notes set status = 'discarded' where id = ${unknown}::uuid`);
    expect(await pendingFleetReview(db)).toEqual({ noteCount: 0, machineCounts: {}, returnMachineCounts: {} });
  });
  it("flags photographed on-lot evidence for a SOLD machine until physical return is reconciled", async () => {
    await upsertFleet(db, mapFleetRows([
      { ID: 5576, Availability: "SOLD", ApplianceType: "Freezer", Brand: "Test", ModelNumber: "FREEZER5576", SerialNumber: "SER5576", Location: "$$$SOLD$$$" }
    ], new Date("2026-05-01T12:00:00Z")).rows);
    const id = await createTechNote(db, { origin: "manual", reading: normalizeReading({
      date: { text: "3/24/26" }, entries: [{
        machine: { text: "5576" }, status: { checked: "READY TO SALE" },
        location: { name: "Showroom - Main" }, note: "Observed on the showroom floor."
      }]
    }) });
    expect(await pendingFleetReview(db)).toEqual({
      noteCount: 1, machineCounts: { "5576": 1 }, returnMachineCounts: { "5576": 1 }
    });
    expect(await pendingMachineNotes(db, "5576")).toMatchObject([{
      id, status: "READY TO SALE", location: "Showroom - Main", verifyReturn: true
    }]);
    expect(await updateMachineStatus(db, { machineNo: "5576", expectedStatus: "SOLD", status: "PARTS ONLY" })).toBe("saved");
    // A status-only edit is incomplete if the location is still the SOLD marker.
    expect(await pendingFleetReview(db)).toEqual({
      noteCount: 1, machineCounts: { "5576": 1 }, returnMachineCounts: { "5576": 1 }
    });
    expect(await updateMachineLocation(db, {
      machineNo: "5576", expectedLocation: "$$SOLD$$", location: "Red Building"
    })).toBe("saved");
    // Return reconciliation requires both the current status and physical location.
    // The dated photo still remains open until its history is reviewed.
    expect(await pendingFleetReview(db)).toEqual({
      noteCount: 1, machineCounts: { "5576": 1 }, returnMachineCounts: {}
    });
  });

});
