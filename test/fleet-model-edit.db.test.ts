import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { bomQueue, fleetSummary, listFleet, machineDetail, mpnDetail, updateMachineModel, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { updateMachineModelAction } from "@/app/actions";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let db: Db;
const inventory = (ID: number, ModelNumber: string, SerialNumber = "CS2412345") => ({
  ID, Brand: "Whirlpool", ModelNumber, SerialNumber, Availability: "PARTS ONLY", ApplianceType: "Washer"
});
const edit = (machineNo: string, model: string, expectedModel = "OLD100", expectedSerial = "CS2412345") =>
  updateMachineModel(db, { machineNo, model, expectedModel, expectedSerial, expectedBrand: "Whirlpool" });

beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([inventory(1, "OLD100"), inventory(2, "OLD100"), inventory(3, "NEW200")]).rows);
  await db.insert(schema.modelBomCache).values([
    { brandKey: "WHIRLPOOL", modelKey: "OLD100", brandDisplay: "Whirlpool", modelDisplay: "OLD100", status: "found", rowCount: 1 },
    { brandKey: "WHIRLPOOL", modelKey: "NEW200", brandDisplay: "Whirlpool", modelDisplay: "NEW200", status: "found", rowCount: 1 }
  ]);
  await db.insert(schema.mpnMaster).values([
    { mpnCanonical: "OLDPART", mpnDisplay: "OLDPART", description: "Old model only" },
    { mpnCanonical: "NEWPART", mpnDisplay: "NEWPART", description: "New model only" }
  ]);
  await db.insert(schema.modelPartEdges).values([
    { brandKey: "WHIRLPOOL", modelKey: "OLD100", mpnCanonical: "OLDPART", mpnDisplay: "OLDPART", source: "test" },
    { brandKey: "WHIRLPOOL", modelKey: "NEW200", mpnCanonical: "NEWPART", mpnDisplay: "NEWPART", source: "test" }
  ]);
});

describe("manual fleet model correction", () => {
  it("moves only the edited machine's supplier and donor identity; shared BOMs remain intact", async () => {
    expect(await edit("1", "NEW-200")).toBe("saved");
    const edited = await machineDetail(db, "1");
    const other = await machineDetail(db, "2");
    expect(edited?.machine).toMatchObject({ modelRaw: "NEW-200", modelKey: "NEW200", source: "manual_model", identityStatus: "ok" });
    expect(edited?.bom?.modelKey).toBe("NEW200");
    expect(edited?.parts.map(p => p.mpn_canonical)).toEqual(["NEWPART"]);
    expect(other?.machine.modelRaw).toBe("OLD100");
    expect(other?.parts.map(p => p.mpn_canonical)).toEqual(["OLDPART"]);
    expect((await db.select().from(schema.modelPartEdges)).length).toBe(2);
    expect((await db.select().from(schema.modelBomCache)).length).toBe(2);
    expect((await mpnDetail(db, "NEWPART"))?.machines.map(m => m.machine_no).sort()).toEqual(["1", "3"]);
    expect((await mpnDetail(db, "OLDPART"))?.machines.map(m => m.machine_no)).toEqual(["2"]);
    expect((await listFleet(db, {})).rows.find(x => x.machine_no === "1")?.model_raw).toBe("NEW-200");
    expect((await fleetSummary(db)).totals.models).toBe(2);
  });

  it("keeps the manual identity across a later fleet import but still updates availability", async () => {
    expect(await edit("1", "NEW200")).toBe("saved");
    await upsertFleet(db, mapFleetRows([
      { ...inventory(1, "OLD100", "DIFFERENT"), Availability: "UNCHECKED" },
      inventory(2, "OLD300")
    ]).rows);
    const [one] = await db.select().from(schema.fleetMachines).where(eq(schema.fleetMachines.machineNo, "1"));
    const [two] = await db.select().from(schema.fleetMachines).where(eq(schema.fleetMachines.machineNo, "2"));
    expect(one).toMatchObject({ modelRaw: "NEW200", modelKey: "NEW200", serial: "CS2412345", availability: "UNCHECKED", source: "manual_model" });
    expect(two).toMatchObject({ modelRaw: "OLD300", modelKey: "OLD300", source: "import" });
  });

  it("moves uncached corrected models to the new parts-list queue", async () => {
    expect(await edit("1", "UNKNOWN500")).toBe("saved");
    expect((await machineDetail(db, "1"))?.bom).toBeUndefined();
    expect((await machineDetail(db, "1"))?.parts).toEqual([]);
    const queue = await bomQueue(db, { availability: "PARTS ONLY" }, ["PARTS ONLY"]);
    expect(queue.rows.map(x => x.model_key)).toContain("UNKNOWN500");
  });

  it("refuses a cross-model correction with recorded part states without losing them", async () => {
    await db.insert(schema.machinePartState).values({ machineNo: "1", mpnCanonical: "OLDPART", state: "pulled" });
    expect(await edit("1", "NEW200")).toBe("has_part_states");
    expect((await machineDetail(db, "1"))?.machine.modelKey).toBe("OLD100");
    expect((await db.select().from(schema.machinePartState)).length).toBe(1);
    expect(await edit("1", "OLD-100")).toBe("saved");
    expect((await db.select().from(schema.machinePartState)).length).toBe(1);
  });

  it("rejects invalid, stale and nonexistent edits", async () => {
    expect(await edit("1", "NO NAMEPLATE")).toBe("invalid");
    expect(await edit("1", "   ")).toBe("invalid");
    expect(await edit("999", "NEW200")).toBe("not_found");
    expect(await edit("1", "NEW200", "OTHER_MODEL")).toBe("conflict");
    expect(await edit("1", "NEW200", "OLD100", "WRONG_SERIAL")).toBe("conflict");
    expect((await machineDetail(db, "1"))?.machine.modelRaw).toBe("OLD100");
  });

  it("routes a save through the server action and reports a refusal for existing harvested states", async () => {
    const form = new FormData();
    for (const [k,v] of Object.entries({ machineNo: "1", model: "NEW200", expectedModel: "OLD100", expectedBrand: "Whirlpool", expectedSerial: "CS2412345" })) form.set(k,v);
    expect((await updateMachineModelAction(null, form)).ok).toBe(true);
    await db.insert(schema.machinePartState).values({ machineNo: "1", mpnCanonical: "NEWPART", state: "pulled" });
    form.set("expectedModel", "NEW200");
    form.set("model", "OLD100");
    const denied = await updateMachineModelAction(null, form);
    expect(denied).toMatchObject({ ok: false });
    expect(denied.message).toContain("recorded");
    expect((await machineDetail(db, "1"))?.machine.modelKey).toBe("NEW200");
  });
});
