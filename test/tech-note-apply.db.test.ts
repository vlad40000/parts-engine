import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { machineDetail, saveModelBom, setPartState, updateMachineLocation, updateMachineStatus, upsertFleet } from "@/src/db/queries";
import {
  applyTechNote, createTechNote, discardTechNote, findNoteByPhoto, getTechNote, getTechNotePhoto, loadPlanFacts, locationList, machineHistory,
  openLocationCheckCount, openLocationChecks, saveDraft, verifyLocation
} from "@/src/db/tech-notes";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { planNote, type Answers } from "@/src/lib/tech-notes/plan";
import { normalizeReading } from "@/src/lib/tech-notes/reading";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";

// Synthetic inventory in the workbook's column layout. No purchaser columns, no real serials.
const row = (ID: number, o: Record<string, string> = {}) => ({
  ID, Availability: "UNCHECKED", ApplianceType: "Washer/Dryer Combo", Brand: "Whirlpool", ModelNumber: "LTE5243DZ0",
  SerialNumber: `MG30${ID}`, Color: "White", Condition: "U - Unchecked", Location: "Warehouse", DateAcquired: "10/11/2025", ...o
});
const NOW = new Date("2026-05-14T15:00:00Z");
const fleet = () => mapFleetRows([
  row(6171),
  row(5000, { Availability: "PARTS ONLY", Condition: "F - Parts Only", Location: "Graveyard" }),
  row(4261, { Availability: "SOLD", Location: "$$$SOLD$$$" }),
  row(611, { Brand: "Speed Queen", ModelNumber: "AWS52NW", ApplianceType: "Washer - Top Load / Agitator", Availability: "NEEDS PARTS", Condition: "E - Needs Parts", Location: "ICU", Diagnosis: "Motor just hums." })
], NOW).rows;
const part = (mpn: string, description: string): SupplierRow => ({ mpnDisplay: mpn, mpnCanonical: mpn, description, diagramId: "1", supplierPartId: null, newPrice: 40, nla: false });
const chain = (rows: SupplierRow[]): ChainResult => ({
  status: "found",
  winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: [{ supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 }]
});

let db: Db;
beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, fleet());
  await saveModelBom(db, { brandKey: "WHIRLPOOL", modelKey: "LTE5243DZ0", brandDisplay: "Whirlpool", modelDisplay: "LTE5243DZ0",
    result: chain([part("WP3948891", "Timer"), part("WP3355806", "Lid Switch Assembly")]) });
});

const reading6171 = () => normalizeReading({
  card: "RR-R1", date: { text: "5/14/26", confidence: "high" },
  entries: [{
    machine: { text: "6171", confidence: "high", alternatives: [] },
    status: { checked: "NEEDS PARTS", phrases: [], confidence: "high" },
    location: { name: "", text: "Red building", confidence: "high" },
    problem: "Timer won't advance but everything works",
    parts: [
      { mpn: "WP394889", name: "timer", action: "needed", otherMachine: "", condition: "bad", confidence: "high" },
      { mpn: "WP3355806", name: "lid switch", action: "replaced", otherMachine: "5000", condition: "", confidence: "high" }
    ]
  }]
});
// Parts lists store WP part numbers under the base number (WP3948891 → 3948891) and keep "WP3948891" for display.
const ANSWERS: Answers = { "location:red building": "add:Red Building", "part:e0:p0": "use:3948891" };
const machine = async (no: string) => (await db.select().from(schema.fleetMachines).where(eq(schema.fleetMachines.machineNo, no)))[0];
/** Plans and applies a reading as a new note; returns the note id. */
const applyReading = async (reading: ReturnType<typeof normalizeReading>, answers: Answers = {}) => {
  const id = await createTechNote(db, { origin: "manual", reading });
  const plan = planNote(reading, await loadPlanFacts(db, reading, answers, NOW), answers);
  expect(plan.unanswered).toBe(0);
  expect(await applyTechNote(db, id, plan, reading, answers)).toBe("applied");
  return { id, plan };
};
/** Start of a shop day (America/New_York, EDT in May). */
const shopDay = (iso: string) => new Date(`${iso}T04:00:00Z`);

describe("tech note apply", () => {
  it("loads facts for named machines, near numbers and parts lists", async () => {
    const facts = await loadPlanFacts(db, normalizeReading({ entries: [{ machine: { text: "6172", confidence: "high", alternatives: [] } }, { machine: { text: "6171" } }] }), {}, NOW);
    expect(Object.keys(facts.machines).sort()).toEqual(["6171"]);
    expect(facts.machines["6171"].bomParts.map((p) => [p.mpn, p.display])).toEqual([["3355806", "WP3355806"], ["3948891", "WP3948891"]]);
    expect(facts.machines["6171"].version).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(facts.today).toBe("2026-05-14");
    expect((await locationList(db)).map((l) => l.name)).toEqual(expect.arrayContaining(["Warehouse", "Graveyard", "ICU", "$$$SOLD$$$"]));
    expect((await locationList(db, true)).map((l) => l.name)).not.toContain("$$$SOLD$$$");
  });

  it("writes every change, event, part state and new location in one go", async () => {
    const reading = reading6171();
    const id = await createTechNote(db, { origin: "manual", reading });
    const facts = await loadPlanFacts(db, reading, ANSWERS, NOW);
    const plan = planNote(reading, facts, ANSWERS);
    expect(plan.ready).toBe(true);
    expect(await applyTechNote(db, id, plan, reading, ANSWERS)).toBe("applied");

    const m = await machine("6171");
    expect(m).toMatchObject({
      availability: "NEEDS PARTS", statusOverride: true, condition: "E - Needs Parts", location: "Red Building",
      diagnosis: "Timer won't advance but everything works. Bad timer (WP3948891).",
      notes: "5/14/26-Location: Red Building. NEEDS PARTS. Replaced lid switch (WP3355806) from #5000.",
      // The written date, not the upload time, is when these decisions were observed.
      lastFieldUpdateAt: shopDay("2026-05-14")
    });
    expect(m.localFields).toEqual(["condition", "diagnosis", "notes"]);
    // Location uses #31's override flag, so the Fleet location editor and tech notes share one rule.
    expect(m.locationOverride).toBe(true);
    // Same rule as the workbook import: diagnosis and repair notes together set the part-family flags.
    expect(m.suspectFamilies).toEqual(["lock_latch"]);
    const status = await db.select().from(schema.fleetStatusEvents);
    expect(status).toMatchObject([{ machineNo: "6171", previousStatus: "UNCHECKED", nextStatus: "NEEDS PARTS", source: "tech_note", techNoteId: id, observedAt: shopDay("2026-05-14") }]);
    const fields = await db.select().from(schema.fleetFieldEvents).orderBy(schema.fleetFieldEvents.field);
    expect(fields.map((f) => [f.field, f.previousValue, f.nextValue])).toEqual([
      ["condition", "U - Unchecked", "E - Needs Parts"],
      ["diagnosis", null, "Timer won't advance but everything works. Bad timer (WP3948891)."],
      ["location", "Warehouse", "Red Building"],
      ["notes", null, "5/14/26-Location: Red Building. NEEDS PARTS. Replaced lid switch (WP3355806) from #5000."]
    ]);
    expect(fields.every((f) => f.techNoteId === id && f.source === "tech_note" && f.applied && f.observedAt?.getTime() === shopDay("2026-05-14").getTime())).toBe(true);
    const decisions = await db.select().from(schema.fleetPartEvents).orderBy(schema.fleetPartEvents.id);
    expect(decisions.map((d) => [d.machineNo, d.mpnCanonical, d.kind, d.applied, d.otherMachine])).toEqual([
      ["6171", "3948891", "failed", true, null],
      ["6171", "3355806", "replaced", true, "5000"],
      ["5000", "3355806", "removed", true, "6171"]
    ]);
    // The move from Warehouse conflicts with the record: VERIFY LOCATION until someone checks.
    expect((await openLocationChecks(db, "6171")).map((c) => [c.previous_location, c.recorded_location, c.observed, c.tech_note_id])).toEqual([["Warehouse", "Red Building", "5/14/26", id]]);
    expect(await openLocationCheckCount(db)).toBe(1);
    const parts = await db.select().from(schema.machinePartState).orderBy(schema.machinePartState.machineNo);
    expect(parts.map((p) => [p.machineNo, p.mpnCanonical, p.state, p.note])).toEqual([
      ["5000", "3355806", "pulled", "for #6171"],
      ["6171", "3948891", "failed", "tech note"]
    ]);
    expect((await locationList(db)).find((l) => l.name === "Red Building")).toEqual({ name: "Red Building", aliases: [] });
    const note = await getTechNote(db, id);
    expect(note).toMatchObject({ status: "applied", answers: ANSWERS, observedOn: "2026-05-14" });
    expect(note?.appliedPlan?.entries[0].changes.length).toBe(5);
    expect((await machineHistory(db, "6171")).map((h) => h.field).sort()).toEqual([
      "VERIFY LOCATION raised", "condition", "diagnosis", "location", "notes", "part failed", "part replaced", "status"
    ]);
    expect(await applyTechNote(db, id, plan, reading, ANSWERS)).toBe("not_open");
  });

  it("keeps note-set fields when the workbook is imported again, and still refreshes the rest", async () => {
    const reading = reading6171();
    const id = await createTechNote(db, { origin: "manual", reading });
    const plan = planNote(reading, await loadPlanFacts(db, reading, ANSWERS, NOW), ANSWERS);
    expect(await applyTechNote(db, id, plan, reading, ANSWERS)).toBe("applied");
    await upsertFleet(db, mapFleetRows([row(6171, { Color: "Cream", Location: "Warehouse", Condition: "U - Unchecked", Diagnosis: "won't drain", StickerPrice: "$300.00" })], NOW).rows);
    expect(await machine("6171")).toMatchObject({
      availability: "NEEDS PARTS", color: "Cream", location: "Red Building", condition: "E - Needs Parts",
      diagnosis: "Timer won't advance but everything works. Bad timer (WP3948891).", suspectFamilies: ["lock_latch"], stickerPrice: "300.00"
    });
    // A machine no note touched still takes every imported value.
    await upsertFleet(db, mapFleetRows([row(5000, { Availability: "PARTS ONLY", Location: "Red Building", Diagnosis: "won't drain" })], NOW).rows);
    expect(await machine("5000")).toMatchObject({ location: "Red Building", diagnosis: "won't drain", suspectFamilies: ["pump"], localFields: [] });
  });

  it("keeps an older note's status, location and part decisions as history without reversing the newer record", async () => {
    await applyReading(reading6171(), ANSWERS);
    const before = await machine("6171");
    const older = normalizeReading({
      date: { text: "5/10/26", confidence: "high" },
      entries: [{
        machine: { text: "6171" }, status: { checked: "PARTS ONLY" }, location: { name: "Graveyard" }, problem: "noisy",
        parts: [{ mpn: "WP3948891", name: "timer", action: "taken", otherMachine: "" }]
      }]
    });
    const { id, plan } = await applyReading(older);
    expect(plan.entries[0].history.map((c) => c.field).sort()).toEqual(["availability", "condition", "diagnosis", "location"]);
    const after = await machine("6171");
    expect(after).toMatchObject({
      availability: "NEEDS PARTS", location: "Red Building", condition: before.condition, diagnosis: before.diagnosis,
      lastFieldUpdateAt: shopDay("2026-05-14")
    });
    expect(after.notes).toBe(`${before.notes} 5/10/26-Location: Graveyard. PARTS ONLY. Took timer (WP3948891). Noisy. (Older than the current record: kept as history.)`);
    const kept = await db.select().from(schema.fleetFieldEvents).where(eq(schema.fleetFieldEvents.techNoteId, id)).orderBy(schema.fleetFieldEvents.field);
    expect(kept.map((f) => [f.field, f.nextValue, f.applied])).toEqual([
      ["condition", "F - Parts Only", false], ["diagnosis", "Noisy.", false], ["location", "Graveyard", false],
      ["notes", after.notes, true], ["status", "PARTS ONLY", false]
    ]);
    // Its words do not flag part families either: it is history.
    expect(after.suspectFamilies).toEqual(before.suspectFamilies);
    // The timer stays failed (5/14); the older "taken out" is history.
    expect((await db.select().from(schema.machinePartState).where(eq(schema.machinePartState.machineNo, "6171")))[0].state).toBe("failed");
    expect((await db.select().from(schema.fleetPartEvents).where(eq(schema.fleetPartEvents.techNoteId, id))).map((d) => [d.kind, d.applied])).toEqual([["removed", false]]);
    expect(await db.select().from(schema.fleetStatusEvents).where(eq(schema.fleetStatusEvents.techNoteId, id))).toEqual([]);
    expect(await openLocationCheckCount(db)).toBe(1);
    expect((await machineHistory(db, "6171")).filter((h) => !h.applied).map((h) => h.field).sort()).toEqual(["condition", "diagnosis", "location", "part removed", "status"]);
  });

  it("asks when a Fleet edit and the note fall on the same day", async () => {
    expect(await updateMachineStatus(db, { machineNo: "611", expectedStatus: "NEEDS PARTS", status: "PARTS ONLY" })).toBe("saved");
    const facts = await loadPlanFacts(db, normalizeReading({ entries: [{ machine: { text: "611" } }] }), {}, new Date());
    const today = facts.today;
    expect(facts.machines["611"].fieldUpdates.availability?.day).toBe(today);
    expect(facts.machines["611"].lastUpdate?.label).toMatch(/\(Fleet edit\), status$/);
    const [y, m, d] = today.split("-");
    const note = normalizeReading({ date: { text: `${Number(m)}/${Number(d)}/${y.slice(2)}` }, entries: [{ machine: { text: "611" }, status: { checked: "NEEDS PARTS" } }] });
    const p = planNote(note, facts, {});
    expect(p.questions.map((q) => q.id)).toEqual(["order:e0"]);
  });

  it("keeps a needed part on pick lists marked test first, and a suspected one too", async () => {
    const reading = normalizeReading({ date: { text: "5/14/26" }, entries: [{
      machine: { text: "6171" }, status: { checked: "NEEDS PARTS" },
      parts: [{ mpn: "WP3948891", name: "timer", action: "needed" }, { mpn: "WP3355806", name: "lid switch", action: "suspected" }]
    }] });
    await applyReading(reading);
    expect(await db.select().from(schema.machinePartState)).toEqual([]);
    const m = await machine("6171");
    expect(m.suspectFamilies).toEqual(expect.arrayContaining(["sensor_switch", "lock_latch"]));
    const detail = await machineDetail(db, "6171");
    expect(detail?.parts.filter((p) => p.suspect).map((p) => p.mpn_canonical).sort()).toEqual(["3355806", "3948891"]);
    expect(detail?.parts.every((p) => p.state == null)).toBe(true);
    expect((await db.select().from(schema.fleetPartEvents)).map((d) => d.kind).sort()).toEqual(["needed", "suspected"]);
    // A part someone records by hand later is newer than the note, and a later-uploaded older note cannot undo it.
    await setPartState(db, "6171", "3948891", "pulled");
    const facts = await loadPlanFacts(db, reading, {}, NOW);
    expect(facts.machines["6171"].partUpdates["3948891"]).toMatchObject({ state: "pulled" });
  });

  it("dates a hand-made part edit now, and applies a same-day note the reviewer confirms over it", async () => {
    await applyReading(reading6171(), ANSWERS);
    // A hand edit after the 5/14 note is a new decision, not the note's.
    await setPartState(db, "6171", "3948891", "pulled");
    const today = (await loadPlanFacts(db, normalizeReading({ entries: [{ machine: { text: "6171" } }] }), {}, new Date())).today;
    const [y, m, d] = today.split("-");
    const sameDay = normalizeReading({ date: { text: `${Number(m)}/${Number(d)}/${y.slice(2)}` }, entries: [{
      machine: { text: "6171" }, parts: [{ mpn: "WP3948891", name: "timer", action: "needed", condition: "missing" }]
    }] });
    const facts = await loadPlanFacts(db, sameDay, {}, new Date());
    expect(facts.machines["6171"].partUpdates["3948891"]).toMatchObject({ day: today, state: "pulled" });
    const asked = planNote(sameDay, facts, {});
    expect(asked.questions.map((q) => q.id)).toContain("order:e0");
    const answers = { "order:e0": "apply" };
    const id = await createTechNote(db, { origin: "manual", reading: sameDay });
    const plan = planNote(sameDay, facts, answers);
    expect(plan.ready).toBe(true);
    expect(await applyTechNote(db, id, plan, sameDay, answers)).toBe("applied");
    const [ps] = await db.select().from(schema.machinePartState).where(eq(schema.machinePartState.machineNo, "6171"));
    expect(ps.state).toBe("missing");
  });

  it("never writes over a part record changed after the plan was made", async () => {
    const reading = normalizeReading({ date: { text: "5/14/26" }, entries: [{
      machine: { text: "6171" }, status: { checked: "NEEDS PARTS" }, parts: [{ mpn: "WP3948891", name: "timer", action: "needed", condition: "bad" }]
    }] });
    const id = await createTechNote(db, { origin: "manual", reading });
    const plan = planNote(reading, await loadPlanFacts(db, reading, {}, NOW), {});
    await setPartState(db, "6171", "3948891", "pulled");
    expect(await applyTechNote(db, id, plan, reading, {})).toBe("applied");
    const [ps] = await db.select().from(schema.machinePartState).where(eq(schema.machinePartState.machineNo, "6171"));
    expect(ps.state).toBe("pulled");
  });

  it("clears VERIFY LOCATION only when someone records where the machine physically is", async () => {
    await applyReading(reading6171(), ANSWERS);
    // A Fleet edit is not a physical check: the alert stays and both moves are in the history.
    expect(await updateMachineLocation(db, { machineNo: "6171", expectedLocation: "Red Building", location: "Shop" })).toBe("saved");
    expect(await openLocationChecks(db, "6171")).toHaveLength(1);
    expect(await verifyLocation(db, { machineNo: "6171", location: "" })).toBe("invalid");
    expect(await verifyLocation(db, { machineNo: "6171", location: "Warehouse" })).toBe("verified");
    expect(await openLocationChecks(db, "6171")).toEqual([]);
    expect(await machine("6171")).toMatchObject({ location: "Warehouse", locationOverride: true });
    const moves = (await machineHistory(db, "6171")).filter((h) => h.field === "location" || h.field.includes("location") || h.field.includes("LOCATION"));
    expect(moves.map((h) => [h.field, h.previous_value, h.next_value, h.source])).toEqual([
      ["location verified", null, "Warehouse", "verified"],
      ["location", "Shop", "Warehouse", "verified"],
      ["location", "Red Building", "Shop", "fleet_ui"],
      ["VERIFY LOCATION raised", "Warehouse", "Red Building", "tech_note"],
      ["location", "Warehouse", "Red Building", "tech_note"]
    ]);
    expect(await verifyLocation(db, { machineNo: "6171", location: "Warehouse" })).toBe("no_open_check");
  });

  it("records a Fleet location edit in the machine history and the location list", async () => {
    expect(await updateMachineLocation(db, { machineNo: "6171", expectedLocation: "Warehouse", location: "Yard A3" })).toBe("saved");
    expect(await machine("6171")).toMatchObject({ location: "Yard A3", locationOverride: true });
    expect((await machineHistory(db, "6171")).map((h) => [h.field, h.previous_value, h.next_value, h.source])).toEqual([["location", "Warehouse", "Yard A3", "fleet_ui"]]);
    expect((await locationList(db)).some((l) => l.name === "Yard A3")).toBe(true);
    // A stale edit writes neither the move nor a history row.
    expect(await updateMachineLocation(db, { machineNo: "6171", expectedLocation: "Warehouse", location: "Shop" })).toBe("conflict");
    expect(await db.select().from(schema.fleetFieldEvents)).toHaveLength(1);
  });

  it("writes nothing when a machine changed after the plan was made", async () => {
    const reading = reading6171();
    const id = await createTechNote(db, { origin: "manual", reading });
    const plan = planNote(reading, await loadPlanFacts(db, reading, ANSWERS, NOW), ANSWERS);
    expect(await updateMachineStatus(db, { machineNo: "6171", expectedStatus: "UNCHECKED", status: "SOLD" })).toBe("saved");
    expect(await applyTechNote(db, id, plan, reading, ANSWERS)).toBe("conflict");
    expect(await machine("6171")).toMatchObject({ availability: "SOLD", location: "Warehouse", localFields: [] });
    expect(await db.select().from(schema.fleetFieldEvents)).toEqual([]);
    expect(await db.select().from(schema.machinePartState)).toEqual([]);
    expect(await db.select().from(schema.fleetPartEvents)).toEqual([]);
    expect(await db.select().from(schema.fleetLocationChecks)).toEqual([]);
    expect((await locationList(db)).some((l) => l.name === "Red Building")).toBe(false);
    expect((await getTechNote(db, id))?.status).toBe("open");
  });

  it("remembers a location wording as an alias of an existing location", async () => {
    const reading = normalizeReading({ date: { text: "5/14/26" }, entries: [{ machine: { text: "611" }, location: { text: "graveyard out back" }, struck: ["Bad motor"] }] });
    const id = await createTechNote(db, { origin: "manual", reading });
    const answers = { "location:graveyard out back": "use:Graveyard", "status:e0": "keep" };
    const plan = planNote(reading, await loadPlanFacts(db, reading, answers, NOW), answers);
    expect(plan.ready).toBe(true);
    expect(await applyTechNote(db, id, plan, reading, answers)).toBe("applied");
    expect((await locationList(db)).find((l) => l.name === "Graveyard")?.aliases).toEqual(["graveyard out back"]);
    expect(await machine("611")).toMatchObject({ availability: "NEEDS PARTS", location: "Graveyard", diagnosis: "Motor just hums." });
  });

  it("stores the photo, finds a re-uploaded photo, saves drafts and discards", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 250]);
    const id = await createTechNote(db, { origin: "photo", photo: { base64: bytes.toString("base64"), type: "image/jpeg", sha256: "a".repeat(64), bytes: bytes.length }, reading: reading6171() });
    expect(await getTechNotePhoto(db, id)).toEqual({ type: "image/jpeg", bytes });
    expect(await findNoteByPhoto(db, "a".repeat(64))).toEqual({ id, status: "open" });
    expect(await saveDraft(db, id, reading6171(), { "part:e0:p0": "keep" })).toBe(true);
    expect((await getTechNote(db, id))?.answers).toEqual({ "part:e0:p0": "keep" });
    expect(await discardTechNote(db, id)).toBe(true);
    expect(await findNoteByPhoto(db, "a".repeat(64))).toBeNull();
    expect(await saveDraft(db, id, reading6171(), {})).toBe(false);
    const [{ n }] = (await db.execute(sql`select count(*)::int n from tech_notes`)).rows as Array<{ n: number }>;
    expect(n).toBe(1);
  });
});
