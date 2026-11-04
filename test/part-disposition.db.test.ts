import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq, sql } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { machineDetail, setPartDisposition, setPartState, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { setPartDispositionAction } from "@/app/actions";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let db: Db;
const inventory = (ID: number) => ({ ID, Brand: "Whirlpool", ModelNumber: "WTW100", SerialNumber: "CS2412345", Availability: "PARTS ONLY", ApplianceType: "Washer" });
const row = async () => (await db.select().from(schema.machinePartState)
  .where(and(eq(schema.machinePartState.machineNo, "1"), eq(schema.machinePartState.mpnCanonical, "PUMP1"))))[0];
const step = (from: Parameters<typeof setPartDisposition>[1]["from"], s: Parameters<typeof setPartDisposition>[1]["step"], extra = {}) =>
  setPartDisposition(db, { machineNo: "1", mpnCanonical: "PUMP1", from, step: s, ...extra });

beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([inventory(1), inventory(2)]).rows);
  await db.insert(schema.modelBomCache).values({ brandKey: "WHIRLPOOL", modelKey: "WTW100", brandDisplay: "Whirlpool", modelDisplay: "WTW100", status: "found", rowCount: 1 });
  await db.insert(schema.mpnMaster).values({ mpnCanonical: "PUMP1", mpnDisplay: "PUMP1", description: "Drain pump" });
  await db.insert(schema.modelPartEdges).values({ brandKey: "WHIRLPOOL", modelKey: "WTW100", mpnCanonical: "PUMP1", mpnDisplay: "PUMP1", source: "test" });
  await setPartState(db, "1", "PUMP1", "pulled");
});

describe("pulled part disposition (DB)", () => {
  it("walks eBay -> Listed -> Sold and back one step at a time, shown on machine detail", async () => {
    expect(await step(null, "ebay")).toBe("saved");
    expect(await step("ebay", "listed")).toBe("saved");
    expect(await step("listed", "sold", { soldPrice: "" })).toBe("invalid_price");
    expect(await step("listed", "sold", { soldPrice: "45.5" })).toBe("saved");
    expect(await row()).toMatchObject({ state: "pulled", disposition: "sold", soldPrice: "45.50" });
    expect((await row()).listedAt).not.toBeNull();
    const part = (await machineDetail(db, "1"))!.parts[0];
    expect(part).toMatchObject({ state: "pulled", disposition: "sold", soldPrice: "45.50", wasListed: true });
    expect(await step("sold", "back")).toBe("saved");
    expect(await row()).toMatchObject({ disposition: "listed", soldPrice: null });
    expect(await step("listed", "back")).toBe("saved");
    expect(await row()).toMatchObject({ disposition: "ebay", listedAt: null });
    expect(await step("ebay", "back")).toBe("saved");
    expect(await row()).toMatchObject({ state: "pulled", disposition: null });
    expect(await step(null, "back")).toBe("saved");
    expect(await row()).toBeUndefined();
  });

  it("Unlisted clears the part (back on the machine) and dates the clear so an older note cannot restore it", async () => {
    await step(null, "ebay");
    await step("ebay", "listed");
    expect(await step("listed", "unlisted")).toBe("saved");
    expect(await row()).toBeUndefined();
    const events = await db.select().from(schema.fleetPartEvents).where(eq(schema.fleetPartEvents.machineNo, "1"));
    expect(events.map((e) => [e.kind, e.source])).toEqual([["cleared", "fleet_ui"]]);
    expect((await machineDetail(db, "1"))!.parts[0].state).toBeNull();
  });

  it("Repair needs a different, existing fleet machine", async () => {
    expect(await step(null, "repair", { repairMachineNo: "" })).toBe("invalid_machine");
    expect(await step(null, "repair", { repairMachineNo: "999" })).toBe("unknown_machine");
    expect(await step(null, "repair", { repairMachineNo: "1" })).toBe("same_machine");
    expect(await step(null, "repair", { repairMachineNo: "#2" })).toBe("saved");
    expect(await row()).toMatchObject({ disposition: "repair", repairMachineNo: "2" });
    expect(await step("repair", "back")).toBe("saved");
    expect(await row()).toMatchObject({ disposition: null, repairMachineNo: null });
  });

  it("rejects a stale page or a skipped step instead of guessing", async () => {
    expect(await step("ebay", "listed")).toBe("conflict");
    expect(await step(null, "listed")).toBe("invalid_step");
    await setPartState(db, "1", "PUMP1", "failed");
    expect(await step(null, "ebay")).toBe("conflict");
  });

  it("a hand or tech-note state other than pulled drops the disposition; the database refuses a mismatch", async () => {
    await step(null, "ebay");
    await setPartState(db, "1", "PUMP1", "missing");
    expect(await row()).toMatchObject({ state: "missing", disposition: null });
    await expect(db.execute(sql`update machine_part_state set disposition = 'ebay' where machine_no = '1'`)).rejects.toThrow();
    await expect(db.execute(sql`update machine_part_state set state = 'pulled', disposition = 'sold' where machine_no = '1'`)).rejects.toThrow();
  });

  it("server action reports validation in plain words", async () => {
    const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries({ machineNo: "1", mpn: "PUMP1", from: "", ...o })) f.set(k, v); return f; };
    expect(await setPartDispositionAction(null, form({ step: "repair", repairMachineNo: "999" }))).toMatchObject({ ok: false, message: "No fleet machine has that Machine ID." });
    expect(await setPartDispositionAction(null, form({ step: "ebay" }))).toMatchObject({ ok: true });
    expect(await setPartDispositionAction(null, form({ step: "sold", from: "ebay", soldPrice: "x" }))).toMatchObject({ ok: false, message: "Enter the sold price (a number, 0 or more)." });
    expect(await setPartDispositionAction(null, form({ step: "bogus" }))).toMatchObject({ ok: false });
  });
});
