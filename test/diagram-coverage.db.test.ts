import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { diagramCoverage } from "@/src/db/diagram-coverage";
import { getModelDiagrams, saveModelDiagrams } from "@/src/db/model-diagrams";
import { getSettings, modelsNeedingBom, upsertFleet } from "@/src/db/queries";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { renderToStaticMarkup } from "react-dom/server";
import DiagramCoveragePage from "@/app/diagram-coverage/page";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ hasDatabase: () => true, getDb: async () => holder.db }));

describe("all-fleet diagram coverage", () => {
  let client: PGlite;
  let db: Db;
  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    holder.db = db;
    await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
    await upsertFleet(db, mapFleetRows([
      { ID: 1, Brand: "Maytag", ModelNumber: "MODEL.0", Availability: "PARTS ONLY" },
      { ID: 2, Brand: "Maytag", ModelNumber: "MODEL.0", Availability: "UNCHECKED" },
      { ID: 3, Brand: "Maytag", ModelNumber: "MODEL.1", Availability: "SOLD" },
      { ID: 4, Brand: "Maytag", ModelNumber: "MODEL0", Availability: "SCRAPPED" },
      { ID: 5, Brand: "GE", ModelNumber: "NO NAMEPLATE", Availability: "SCRAPED" },
      { ID: 6, Brand: "LG", ModelNumber: "ABC", Availability: "SOLD" }
    ]).rows);
    await saveModelDiagrams(db, { brand: "Maytag", modelRaw: "MODEL.0" }, {
      sourceSha256: "fixture", sourceUrl: "https://encompass.com/example", sourceNote: "reviewed", sections: []
    }, "");
    await db.insert(schema.modelBomCache).values({ brandKey: "MAYTAG", modelKey: "MODEL0", brandDisplay: "Maytag", modelDisplay: "MODEL.0", status: "found", source: "appliancepartspros", sourceUrl: "https://www.appliancepartspros.com/example" });
  });
  afterAll(async () => { await client.close(); });

  it("counts every status, keeps exact revisions distinct, and reports nameplates", async () => {
    const q = await diagramCoverage(db);
    expect(q).toMatchObject({ totalMachines: 6, totalGroups: 4, coveredGroups: 1, coveredMachines: 2 });
    expect(q.nameplates.map((m) => m.machineNo)).toEqual(["5"]);
    expect(q.rows.find((r) => r.model === "MODEL.0")).toMatchObject({ covered: true, statuses: { "PARTS ONLY": 1, UNCHECKED: 1 }, lead: { source: "appliancepartspros" } });
    expect(q.rows.find((r) => r.model === "MODEL.1")).toMatchObject({ covered: false, statuses: { SOLD: 1 } });
    expect(q.rows.find((r) => r.model === "MODEL0")).toMatchObject({ covered: false, statuses: { SCRAPPED: 1 } });
    expect(q.rows.find((r) => r.brand === "LG")).toMatchObject({ covered: false, statuses: { SOLD: 1 } });
    expect(await getModelDiagrams(db, { brand: "Maytag", modelRaw: "MODEL.0" })).not.toBeNull();
    expect(await getModelDiagrams(db, { brand: "Maytag", modelRaw: "MODEL.1" })).toBeNull();
  });

  it("filters machine counts by status without changing donor eligibility", async () => {
    const sold = await diagramCoverage(db, "SOLD");
    expect(sold).toMatchObject({ totalMachines: 2, totalGroups: 2, coveredGroups: 0 });
    expect((await diagramCoverage(db, "UNCHECKED")).rows[0]).toMatchObject({ covered: true, statuses: { UNCHECKED: 1 } });
    const donors = (await getSettings(db)).donorAvailabilities;
    const queue = await modelsNeedingBom(db, { availability: "include_unchecked" }, donors, 100);
    expect(queue.some((row) => row.model_key === "MODEL1" || row.model_key === "ABC")).toBe(false);
  });

  it("shows unresolved variations even for saved diagrams", async () => {
    const html = renderToStaticMarkup(await DiagramCoveragePage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Variation unverified");
    expect(html).toContain("Saved diagrams");
    expect(html).toContain("Needs nameplate (1)");
    expect(html).toContain("SCRAPPED: 1");
  });
});
