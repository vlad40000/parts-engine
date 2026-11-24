import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { importMaytag6613DiagramAction } from "@/app/model-diagram-actions";
import { diagramCoverage } from "@/src/db/diagram-coverage";
import { getModelDiagrams, saveModelDiagrams } from "@/src/db/model-diagrams";
import { upsertFleet } from "@/src/db/queries";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { MAYTAG_DIAGRAM_PILOT } from "@/src/lib/maytag-6613-diagram";
import { calloutRecordsFor } from "@/src/lib/model-diagrams";

const importKey = "a".repeat(32);
const pilot = MAYTAG_DIAGRAM_PILOT;
const model = { brand: pilot.brand, modelRaw: pilot.model };
const observedSha256 = "48b3d54e6b7a5d74846f83040288182277af552e7091e11efd35891cd005407d";
let db: Db;
let client: PGlite;

vi.mock("@/src/db", () => ({ getDb: async () => db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function request(machineNo = String(pilot.machineNo), key = importKey) {
  const form = new FormData();
  form.set("machineNo", machineNo);
  form.set("importKey", key);
  return importMaytag6613DiagramAction(null, form);
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    { ID: pilot.machineNo, Brand: pilot.brand, ModelNumber: pilot.model, Serial: pilot.serial, Availability: "PARTS ONLY" },
    { ID: "REH-ADJACENT", Brand: pilot.brand, ModelNumber: "MVW6230HW0", Availability: "PARTS ONLY" }
  ]).rows);
});

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await client.close(); });

describe("reviewed Maytag 6613 operator import", () => {
  it("requires the import key, enabled environment, and exact machine identity", async () => {
    vi.stubEnv("DIAGRAM_IMPORT_KEY", importKey);
    vi.stubEnv("VERCEL_ENV", "preview");
    await expect(request()).resolves.toMatchObject({ ok: false, message: expect.stringContaining("authorized") });

    vi.stubEnv("VERCEL_ENV", "production");
    await expect(request(pilot.machineNo, "wrong")).resolves.toMatchObject({ ok: false, message: expect.stringContaining("authorized") });
    await expect(request("6601")).resolves.toMatchObject({ ok: false, message: expect.stringContaining("6613") });

    const target = eq(schema.fleetMachines.machineNo, pilot.machineNo);
    await db.update(schema.fleetMachines).set({ serial: "CA1304280" }).where(target);
    try {
      await expect(request()).resolves.toMatchObject({ ok: false, message: expect.stringContaining("model and serial") });
      expect(await getModelDiagrams(db, model)).toBeNull();
    } finally {
      await db.update(schema.fleetMachines).set({ serial: pilot.serial }).where(target);
    }
  });

  it("imports the rehearsed evidence exactly once and protects different saved evidence", async () => {
    vi.stubEnv("DIAGRAM_IMPORT_KEY", importKey);
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(request()).resolves.toMatchObject({ ok: true });
    await expect(request()).resolves.toMatchObject({ ok: true });
    const stored = await getModelDiagrams(db, model);
    expect(stored?.sourceSha256).toBe(observedSha256);
    expect(stored?.evidence.sections).toHaveLength(6);
    expect(stored?.evidence.sections.reduce((count, section) => count + section.parts.length, 0)).toBe(116);
    expect(stored?.evidence.sections.find((section) => section.assembly.startsWith("02"))?.note).toContain("1A, 1");
    expect(calloutRecordsFor(stored!.evidence, pilot.machineNo).map((record) => [record.role, record.partNumber])).toEqual([
      ["catalog", "W11479877"], ["supplier_listed", "W11543994"], ["observed", "W11538088"], ["replacement", "W11543994"]
    ]);
    expect(calloutRecordsFor(stored!.evidence, "6601").some((record) => record.role === "observed")).toBe(false);
    expect(await getModelDiagrams(db, { ...model, modelRaw: "MVW6230HW0" })).toBeNull();
    expect(await diagramCoverage(db)).toMatchObject({ coveredGroups: 1, coveredMachines: 1 });

    const differentSha256 = "f".repeat(64);
    expect(await saveModelDiagrams(db, model, {
      ...stored!.evidence, sourceNote: "Different reviewed evidence", sourceSha256: differentSha256
    }, observedSha256)).toBe(true);
    await expect(request()).resolves.toMatchObject({ ok: false, message: expect.stringContaining("Different diagram evidence") });
    expect((await getModelDiagrams(db, model))?.sourceSha256).toBe(differentSha256);
  });
});
