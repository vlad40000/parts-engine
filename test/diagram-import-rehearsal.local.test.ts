import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { ADJACENT, rehearsalView, seedRehearsal, SHOWN } from "./diagram-rehearsal-support";

/**
 * Seeds an on-disk disposable database for the real app to serve (local only, never in CI):
 *
 *   DATABASE_URL=pglite:/tmp/rehearsal-db node scripts/migrate.mjs --plan      # then apply with --expect
 *   DIAGRAM_REHEARSAL_DB=/tmp/rehearsal-db npx vitest run test/diagram-import-rehearsal.local.test.ts
 *   DATABASE_URL=pglite:/tmp/rehearsal-db npx next start -p 3101               # then open /machines/6613
 *
 * The directory must already hold the migrated schema and nothing else; the run refuses a database with fleet rows.
 */
const dir = process.env.DIAGRAM_REHEARSAL_DB;

describe.skipIf(!dir)("diagram import rehearsal database (local only)", () => {
  it("seeds MVW6230HW1, its neighbours, the replayed BOM and the reviewed bundle", async () => {
    const client = new PGlite(dir!);
    try {
      const db = drizzle(client, { schema }) as unknown as Db;
      expect(await db.select().from(schema.fleetMachines)).toEqual([]);
      const { bom, imported } = await seedRehearsal(db);
      console.log(JSON.stringify({ bom: { status: bom.status, supplier: bom.winner?.supplier, rows: bom.winner?.rows.length }, imported }));
      for (const machineNo of [...SHOWN, ...ADJACENT]) {
        const v = await rehearsalView(db, machineNo);
        console.log(JSON.stringify({ machineNo, model: v.model, diagrams: v.entry ? v.entry.evidence.sections.length : v.entry, bomRows: v.bomRows, board: v.boardReferences, records: v.records.map((r) => `${r.role}:${r.partNumber}`) }));
      }
    } finally {
      await client.close();
    }
  });
});
