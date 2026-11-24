import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { readFileSync } from "node:fs";
import { diagramCoverage, DIAGRAM_COVERAGE_PAGE_SIZE } from "@/src/db/diagram-coverage";
import { getModelDiagrams, saveModelDiagrams } from "@/src/db/model-diagrams";
import { getSettings, modelsNeedingBom, upsertFleet } from "@/src/db/queries";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { mapFleetRows } from "@/src/lib/fleet-import";
import type { ModelDiagramSection } from "@/src/lib/model-diagrams";
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
      { ID: "5-1", Brand: "GE", ModelNumber: "NO NAMEPLATE", Availability: "SCRAPED" },
      { ID: 6, Brand: "LG", ModelNumber: "ABC", Availability: "SOLD" },
      { ID: 7, Brand: "GE", ModelNumber: "EMPTY", Availability: "SOLD" },
      { ID: 8, Brand: "GE", ModelNumber: "IMAGE", Availability: "SCRAPPED" },
      { ID: 9, Brand: "GE", ModelNumber: "BADROW", Availability: "PARTS ONLY" },
      { ID: 10, Brand: "GE", ModelNumber: "BADURL", Availability: "PARTS ONLY" }
    ]).rows);
    await saveModelDiagrams(db, { brand: "Maytag", modelRaw: "MODEL.0" }, {
      sourceSha256: "fixture", sourceUrl: "https://encompass.com/example", sourceNote: "reviewed", sections: [
        { assembly: "05 - Pump", imageUrl: "https://cdn.datamanager.arinet.com/image/WHI/test-pump/Max", note: "", parts: [{ callout: "5A", partNumber: "WP123456", description: "Clamp" }] }
      ]
    }, "");
    const section = { assembly: "Pump", imageUrl: "https://example.com/pump", note: "", parts: [] };
    const fixtures: [string, ModelDiagramSection[]][] = [
      ["EMPTY", []], ["IMAGE", [section]], ["BADROW", [{ ...section, parts: [{ callout: "1", partNumber: "---", description: "" }, { callout: " ", partNumber: "P123", description: "" }] }]],
      ["BADURL", [{ ...section, imageUrl: "javascript:alert(1)", parts: [{ callout: "1", partNumber: "P123", description: "" }] }]]
    ];
    for (const [modelRaw, sections] of fixtures) {
      await saveModelDiagrams(db, { brand: "GE", modelRaw }, { sourceSha256: "fixture", sourceUrl: "https://example.com", sourceNote: "", sections: [...sections] }, "");
    }
    await db.insert(schema.modelBomCache).values([
      { brandKey: "MAYTAG", modelKey: "MODEL0", brandDisplay: "Maytag", modelDisplay: "MODEL.0", status: "found", source: "appliancepartspros", sourceUrl: "https://www.appliancepartspros.com/example" },
      { brandKey: "GE", modelKey: "BADURL", brandDisplay: "GE", modelDisplay: "BADURL", status: "found", source: "test", sourceUrl: "javascript:alert(1)" },
      { brandKey: "GE", modelKey: "EMPTY", brandDisplay: "GE", modelDisplay: "EMPTY", status: "found", source: "test", sourceUrl: "not a url" }
    ]);
  });
  afterAll(async () => { await client.close(); });

  it("counts every status, keeps exact revisions distinct, and reports nameplates", async () => {
    const q = await diagramCoverage(db);
    expect(q).toMatchObject({ totalMachines: 10, totalGroups: 8, coveredGroups: 1, coveredMachines: 2, savedGroups: 5 });
    expect(q.nameplates.map((m) => m.machineNo)).toEqual(["5-1"]);
    expect(q.rows.find((r) => r.model === "MODEL.0")).toMatchObject({ coverage: "usable", statuses: { "PARTS ONLY": 1, UNCHECKED: 1 }, lead: { source: "appliancepartspros", exactRequest: true } });
    expect(q.rows.find((r) => r.model === "MODEL.1")).toMatchObject({ coverage: "awaiting", statuses: { SOLD: 1 } });
    expect(q.rows.find((r) => r.model === "MODEL0")).toMatchObject({ coverage: "awaiting", statuses: { SCRAPPED: 1 }, lead: { exactRequest: false } });
    expect(q.rows.find((r) => r.brand === "LG")).toMatchObject({ coverage: "awaiting", statuses: { SOLD: 1 }, lead: null });
    expect(q.rows.find((r) => r.model === "EMPTY")).toMatchObject({ coverage: "needs_review", lead: null });
    expect(q.rows.find((r) => r.model === "IMAGE")).toMatchObject({ coverage: "diagram_only" });
    expect(q.rows.find((r) => r.model === "BADROW")).toMatchObject({ coverage: "needs_review" });
    expect(q.rows.find((r) => r.model === "BADURL")).toMatchObject({ coverage: "needs_review", lead: null });
    expect(await getModelDiagrams(db, { brand: "Maytag", modelRaw: "MODEL.0" })).not.toBeNull();
    expect(await getModelDiagrams(db, { brand: "Maytag", modelRaw: "MODEL.1" })).toBeNull();
  });

  it("filters machine counts by status without changing donor eligibility", async () => {
    const sold = await diagramCoverage(db, { status: "SOLD" });
    expect(sold).toMatchObject({ totalMachines: 3, totalGroups: 3, coveredGroups: 0 });
    expect((await diagramCoverage(db, { status: "UNCHECKED" })).rows[0]).toMatchObject({ coverage: "usable", statuses: { UNCHECKED: 1 } });
    const donors = (await getSettings(db)).donorAvailabilities;
    const queue = await modelsNeedingBom(db, { availability: "include_unchecked" }, donors, 100);
    expect(queue.some((row) => row.model_key === "MODEL1" || row.model_key === "ABC")).toBe(false);
  });

  it("keeps coverage totals independent of supplier leads", async () => {
    const before = await diagramCoverage(db);
    const condition = and(eq(schema.modelBomCache.brandKey, "MAYTAG"), eq(schema.modelBomCache.modelKey, "MODEL0"));
    const [lead] = await db.delete(schema.modelBomCache).where(condition).returning();
    try {
      const after = await diagramCoverage(db);
      expect(after).toMatchObject({ coveredGroups: before.coveredGroups, coveredMachines: before.coveredMachines, savedGroups: before.savedGroups });
      expect(after.rows.find((r) => r.model === "MODEL.0")?.lead).toBeNull();
    } finally { await db.insert(schema.modelBomCache).values(lead); }
  });

  it("shows unresolved variations even for saved diagrams", async () => {
    const html = renderToStaticMarkup(await DiagramCoveragePage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Variation unverified");
    expect(html).toContain("Usable diagram and callout evidence");
    expect(html).toContain("Saved diagram-only evidence");
    expect(html).toContain("Saved record needs review");
    expect(html).toContain("Supplier discovery lead");
    expect(html).toContain("Possible supplier lead · exact model/revision unverified");
    expect(html).toContain("Needs nameplate (1)");
    expect(html).toContain("SCRAPPED: 1");
  });

  it("combines model, machine ID, and status in both the counts and rows", async () => {
    const byModel = await diagramCoverage(db, { model: " model. " });
    expect(byModel).toMatchObject({ totalMachines: 3, totalGroups: 2, coveredGroups: 1, coveredMachines: 2 });
    expect(byModel.rows.map((row) => row.model)).toEqual(["MODEL.1", "MODEL.0"]);

    const params = { model: "model.0", machineNo: "2", status: "UNCHECKED", offset: "100" };
    const byMachine = await diagramCoverage(db, { ...params, offset: Number(params.offset) });
    expect(byMachine).toMatchObject({
      totalMachines: 1, totalGroups: 1, coveredMachines: 1, offset: 0,
      rows: [{ machines: ["2"], model: "MODEL.0", coverage: "usable", statuses: { UNCHECKED: 1 } }]
    });
    expect(await diagramCoverage(db, { ...params, status: "SOLD", offset: 0 })).toMatchObject({ totalMachines: 0, rows: [] });

    const html = renderToStaticMarkup(await DiagramCoveragePage({ searchParams: Promise.resolve(params) }));
    expect(html).toContain('name="model"');
    expect(html).toContain('name="machineNo"');
    expect(html).toContain('href="/machines/2"');
    expect(html).not.toContain('href="/machines/1"');
    expect(html).toContain("Clear filters");
  });

  it("finds exact hyphenated machine IDs in nameplate review", async () => {
    const result = await diagramCoverage(db, { machineNo: " 5-1 " });
    expect(result).toMatchObject({ totalMachines: 1, totalGroups: 0, nameplates: [{ machineNo: "5-1" }] });
    expect(await diagramCoverage(db, { machineNo: "5" })).toMatchObject({ totalMachines: 0, nameplates: [] });
  });

  it("keeps the selected model and status on pagination links", async () => {
    const records = Array.from({ length: DIAGRAM_COVERAGE_PAGE_SIZE + 1 }, (_, i) => ({
      ID: `PAGE-${i}`, Brand: "GE", ModelNumber: `PAGING-${String(i).padStart(3, "0")}`, Availability: "SOLD"
    }));
    await upsertFleet(db, mapFleetRows(records).rows);
    try {
      const search = { model: "paging-", status: "SOLD" };
      const firstPage = renderToStaticMarkup(await DiagramCoveragePage({ searchParams: Promise.resolve(search) }));
      expect(firstPage).toContain(`?status=SOLD&amp;model=paging-&amp;offset=${DIAGRAM_COVERAGE_PAGE_SIZE}`);
      const lastPage = await diagramCoverage(db, { ...search, offset: DIAGRAM_COVERAGE_PAGE_SIZE });
      expect(lastPage).toMatchObject({ totalGroups: DIAGRAM_COVERAGE_PAGE_SIZE + 1, rows: [{ machines: ["PAGE-100"] }] });
    } finally {
      await db.delete(schema.fleetMachines).where(inArray(schema.fleetMachines.machineNo, records.map((record) => record.ID)));
    }
  });
});

describe("coverage migration compatibility", () => {
  it("renders an 0008 database, preserving filters and leads while reporting coverage unavailable", async () => {
    const client = new PGlite();
    try {
      for (const file of ["0000_init.sql", "0001_roadrunner_sale_events.sql", "0002_economics_v7.sql", "0003_harvest_time_observations.sql", "0004_research_evidence_batches.sql", "0005_fleet_status_edits.sql", "0006_fleet_location_edits.sql", "0007_tech_notes.sql", "0008_pulled_part_disposition.sql"]) {
        for (const statement of readFileSync(path.join(__dirname, "..", "drizzle", file), "utf8").split("--> statement-breakpoint").filter((s) => s.trim())) await client.exec(statement);
      }
      const db = drizzle(client, { schema }) as unknown as Db;
      holder.db = db;
      await upsertFleet(db, mapFleetRows([
        { ID: 20, Brand: "Maytag", ModelNumber: "MODEL.0", Availability: "SOLD" },
        { ID: 21, Brand: "GE", ModelNumber: "NO NAMEPLATE", Availability: "SOLD" },
        { ID: 22, Brand: "GE", ModelNumber: "OTHER", Availability: "UNCHECKED" }
      ]).rows);
      await db.insert(schema.modelBomCache).values({ brandKey: "MAYTAG", modelKey: "MODEL0", brandDisplay: "Maytag", modelDisplay: "MODEL.0", status: "found", source: "test", sourceUrl: "https://example.com" });
      expect(await diagramCoverage(db, { status: "SOLD" })).toMatchObject({ totalMachines: 2, coverageAvailable: false, coveredGroups: null, coveredMachines: null, savedGroups: null });
      const allHtml = renderToStaticMarkup(await DiagramCoveragePage({ searchParams: Promise.resolve({}) }));
      expect(allHtml).toContain("OTHER");
      expect(allHtml).toContain("Diagram coverage unavailable");
      const html = renderToStaticMarkup(await DiagramCoveragePage({ searchParams: Promise.resolve({ status: "SOLD" }) }));
      expect(html).toContain("Diagram coverage unavailable");
      expect(html).toContain("Supplier discovery lead");
      expect(html).toContain("Needs nameplate (1)");
      expect(html).not.toContain("OTHER</td>");
      await client.exec('ALTER TABLE "fleet_machines" RENAME TO "fleet_machines_missing"');
      await expect(diagramCoverage(db)).rejects.toThrow();
    } finally { await client.close(); }
  });

  it("reports zero saved diagrams in an empty migrated 0009 database", async () => {
    const client = new PGlite();
    try {
      await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
      const db = drizzle(client, { schema }) as unknown as Db;
      holder.db = db;
      expect(await diagramCoverage(db)).toMatchObject({ coverageAvailable: true, savedGroups: 0, coveredGroups: 0, coveredMachines: 0 });
      const html = renderToStaticMarkup(await DiagramCoveragePage({ searchParams: Promise.resolve({}) }));
      expect(html).toContain("0 groups with saved diagrams");
      expect(html).not.toContain("Diagram coverage unavailable");
    } finally { await client.close(); }
  });
});
