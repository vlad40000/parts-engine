import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { addAlias, setPartDisposition, setPartState, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { resolveOriginalMpn } from "@/src/lib/original-mpn-resolver";
import { SYNTHETIC_BREAK, SYNTHETIC_CONTROL } from "./fixtures/original-mpn-evidence";

it("preserves an existing supersession alias, BOM edge, part state and history during prediction", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema }) as unknown as Db;
    await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
    const serial = "SL199999Q";
    const [machine] = mapFleetRows([{
      ID: 1, Brand: SYNTHETIC_CONTROL.brand, ModelNumber: SYNTHETIC_CONTROL.model, SerialNumber: serial,
      Availability: "PARTS ONLY", ApplianceType: "Washer"
    }]).rows;
    await upsertFleet(db, [machine]);
    await addAlias(db, "TEST-A", "SERVICE-A", "supersedes");
    await db.insert(schema.modelPartEdges).values({
      brandKey: machine.brandKey, modelKey: machine.modelKey, mpnCanonical: "SERVICEA", mpnDisplay: "TEST-A", source: "fixture"
    });
    const part = { machineNo: machine.machineNo, mpnCanonical: "SERVICEA" };
    await setPartState(db, part.machineNo, part.mpnCanonical, "pulled");
    expect(await setPartDisposition(db, { ...part, from: null, step: "ebay" })).toBe("saved");
    expect(await setPartDisposition(db, { ...part, from: "ebay", step: "listed" })).toBe("saved");
    expect(await setPartDisposition(db, { ...part, from: "listed", step: "sold", soldPrice: "45.00" })).toBe("saved");
    await db.insert(schema.roadrunnerSaleEvents).values({
      source: "fixture", sourceEventId: "sale-1", mpnCanonical: "SERVICEA", mpnDisplay: "SERVICE-A",
      soldAt: "2026-11-01", quantity: 1, itemPrice: "45.00"
    });

    const snapshot = async () => ({
      fleet: await db.select().from(schema.fleetMachines),
      aliases: await db.select().from(schema.mpnAlias),
      bom: await db.select().from(schema.modelPartEdges),
      state: await db.select().from(schema.machinePartState),
      disposition: await db.select().from(schema.machinePartDispositionEvents).orderBy(schema.machinePartDispositionEvents.id),
      sales: await db.select().from(schema.roadrunnerSaleEvents)
    });
    const before = await snapshot();
    const input = { ...SYNTHETIC_CONTROL, machineNo: machine.machineNo, serial, asOfYear: 2026 };
    expect(resolveOriginalMpn(input, SYNTHETIC_BREAK).factoryOriginalPrediction).toMatchObject({
      status: "serial_supported", resolvedMpnCanonical: "TESTA"
    });
    expect(resolveOriginalMpn({ ...input, serial: "SL200000Q" }, SYNTHETIC_BREAK).factoryOriginalPrediction.resolvedMpnCanonical)
      .toBe("TESTB");
    expect(await snapshot()).toEqual(before);
  } finally {
    await client.close();
  }
});
