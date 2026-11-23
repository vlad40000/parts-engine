import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { importDiagramWorkbookAction } from "@/app/model-diagram-actions";
import { getModelDiagrams } from "@/src/db/model-diagrams";
import { machineDetail, setPartState, upsertFleet } from "@/src/db/queries";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { readModelDiagramWorkbook } from "@/src/lib/model-diagram-workbook";
import { diagramReferencesByMpn } from "@/src/lib/model-diagrams";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const model = { brand: "Maytag", modelRaw: "MODEL.0" };
const importKey = "test-only-review-key-8f870420725aaf";
const pumpUrl = "https://cdn.datamanager.arinet.com/image/WHI/test-pump/Max?ariz=5";
const optionalUrl = "https://cdn.datamanager.arinet.com/image/WHI/test-optional/Max?ariz=5";
const sourceUrl = "https://encompass.com/Exploded-View-Assembly/WHI/500/MODEL.0";

async function workbookFile({ source = sourceUrl, count = 2, secondLink = pumpUrl, note = "Captured on 2026-11-19" } = {}) {
  const workbook = new ExcelJS.Workbook();
  const parts = workbook.addWorksheet("Parts");
  parts.addRow(["Assembly", "Callout", "Part Number", "Description", "Diagram"]);
  parts.addRow(["05 - Pump", 5, "WP123456", "Clamp", { text: "Diagram", hyperlink: pumpUrl }]);
  parts.addRow(["05 - Pump", "5A", "WP123456", "Clamp", { text: "Diagram", hyperlink: secondLink }]);
  const diagrams = workbook.addWorksheet("Diagrams");
  diagrams.addRow(["Assembly", "Callouts", "Diagram", "Note"]);
  diagrams.addRow(["05 - Pump", count, { text: "Open", hyperlink: pumpUrl }]);
  diagrams.addRow(["06 - Optional", 0, { text: "Open", hyperlink: optionalUrl }, "Non-illustrated"]);
  diagrams.addRow(["Source", null, { text: "Encompass exploded view", hyperlink: source }, note]);
  const bytes = await workbook.xlsx.writeBuffer();
  return new File([new Uint8Array(bytes)], "diagram-book.xlsx");
}

async function upload(file: File, machineNo: string, expectedSha256 = "", suppliedKey = importKey) {
  const form = new FormData();
  form.set("file", file);
  form.set("machineNo", machineNo);
  form.set("expectedSha256", expectedSha256);
  form.set("importKey", suppliedKey);
  return importDiagramWorkbookAction(null, form);
}

describe("Encompass diagram workbooks", () => {
  it("keeps hyperlink targets, repeated MPNs, alphanumeric callouts, and zero-callout assemblies", async () => {
    const result = await readModelDiagramWorkbook(await workbookFile(), model.brand, model.modelRaw);
    expect(result.sourceUrl).toBe(sourceUrl);
    expect(result.sections.map((section) => section.parts.length)).toEqual([2, 0]);
    expect(result.sections[1]).toMatchObject({ imageUrl: optionalUrl, note: "Non-illustrated" });
    const references = diagramReferencesByMpn(result.sections);
    expect(references.get("WP123456")).toEqual([
      { assembly: "05 - Pump", callout: "5", imageUrl: pumpUrl },
      { assembly: "05 - Pump", callout: "5A", imageUrl: pumpUrl }
    ]);
    expect(references.has("123456")).toBe(false);
  });

  it("rejects a different model or manufacturer, mismatched diagrams, and missing callout rows", async () => {
    const file = await workbookFile();
    await expect(readModelDiagramWorkbook(file, model.brand, "MODEL0")).rejects.toThrow(/does not match/);
    await expect(readModelDiagramWorkbook(file, "GE", model.modelRaw)).rejects.toThrow(/does not match/);
    await expect(readModelDiagramWorkbook(await workbookFile({ secondLink: optionalUrl }), model.brand, model.modelRaw)).rejects.toThrow(/Parts row 3/);
    await expect(readModelDiagramWorkbook(await workbookFile({ count: 3 }), model.brand, model.modelRaw)).rejects.toThrow(/3 callouts but has 2/);
    await expect(readModelDiagramWorkbook(new File(["Open"], "diagrams.csv"), model.brand, model.modelRaw)).rejects.toThrow(/XLSX/);
  });
});

describe("model diagrams on fleet machines", () => {
  let client: PGlite;
  let db: Db;

  beforeAll(async () => {
    vi.stubEnv("DIAGRAM_IMPORT_KEY", importKey);
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    holder.db = db;
    await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
    await upsertFleet(db, mapFleetRows(["MODEL.0", "MODEL.0", "MODEL0", "MODEL.1"].map((ModelNumber, i) => ({
      ID: i + 1, Brand: "Maytag", ModelNumber, Availability: "PARTS ONLY", ApplianceType: "Washer"
    }))).rows);
    await db.insert(schema.mpnMaster).values({ mpnCanonical: "WP123456", mpnDisplay: "WP123456", description: "Clamp" });
    await db.insert(schema.modelPartEdges).values({ brandKey: "MAYTAG", modelKey: "MODEL0", mpnCanonical: "WP123456", mpnDisplay: "WP123456", source: "test" });
    await setPartState(db, "1", "WP123456", "pulled");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await client.close();
  });

  it("checks authorization before processing an import", async () => {
    const file = await workbookFile();
    try {
      expect(await upload(file, "1", "", "")).toMatchObject({ ok: false, message: expect.stringMatching(/authorized import key/) });
      expect(await upload(file, "1", "", "wrong-key")).toMatchObject({ ok: false });
      vi.stubEnv("VERCEL_ENV", "preview");
      expect(await upload(file, "1")).toMatchObject({ ok: false });
      vi.stubEnv("VERCEL_ENV", undefined);
      vi.stubEnv("DIAGRAM_IMPORT_KEY", undefined);
      expect(await upload(file, "1")).toMatchObject({ ok: false });
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("DIAGRAM_IMPORT_KEY", importKey);
    }
    expect(await getModelDiagrams(db, model)).toBeNull();
  });

  it("saves once per exact model, refuses stale replacements, and preserves the BOM and pulled state", async () => {
    const firstFile = await workbookFile();
    expect(await upload(firstFile, "3")).toMatchObject({ ok: false, message: expect.stringMatching(/does not match/) });
    expect(await upload(firstFile, "1")).toMatchObject({ ok: true, message: expect.stringMatching(/2 assembly diagrams and 2 callout rows/) });
    const first = await getModelDiagrams(db, model);
    expect(first?.evidence.sections).toHaveLength(2);
    const sameModel = (await machineDetail(db, "2"))!.machine;
    const otherModel = (await machineDetail(db, "3"))!.machine;
    expect(await getModelDiagrams(db, sameModel)).toEqual(first);
    expect(await getModelDiagrams(db, otherModel)).toBeNull();
    expect(await getModelDiagrams(db, { ...model, modelRaw: "MODEL.1" })).toBeNull();
    expect(await upload(firstFile, "2")).toMatchObject({ ok: true });
    expect(await getModelDiagrams(db, sameModel)).toEqual(first);

    const replacement = await workbookFile({ note: "Reviewed capture" });
    expect(await upload(replacement, "2")).toMatchObject({ ok: false, message: expect.stringMatching(/Another workbook/) });
    expect(await upload(replacement, "2", first!.sourceSha256)).toMatchObject({ ok: true });
    expect((await getModelDiagrams(db, model))?.evidence.sourceNote).toBe("Reviewed capture");
    expect(await upload(firstFile, "1", first!.sourceSha256)).toMatchObject({ ok: false });
    expect(await db.select().from(schema.modelDiagrams)).toHaveLength(1);
    expect(await db.select().from(schema.modelPartEdges)).toHaveLength(1);
    expect((await machineDetail(db, "1"))?.parts[0]).toMatchObject({ mpn_canonical: "WP123456", state: "pulled" });
  });

  it("leaves the machine readable when the diagram migration has not run", async () => {
    const legacy = new PGlite();
    try {
      expect(await getModelDiagrams(drizzle(legacy) as unknown as Db, model)).toBeUndefined();
    } finally {
      await legacy.close();
    }
  });
});
