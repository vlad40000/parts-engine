import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { ModelDiagramPanel } from "@/src/components/model-diagram-panel";
import { getModelDiagrams } from "@/src/db/model-diagrams";
import { saveDiagramBundle } from "@/src/db/model-diagram-bundle";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { DiagramBundleError, diagramBundleEvidence } from "@/src/lib/model-diagram-bundle";
import { ADJACENT, maytagBundle, rehearsalView, seedRehearsal, SHOWN } from "./diagram-rehearsal-support";

vi.mock("@/src/db", () => ({ getDb: async () => { throw new Error("not used"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let client: PGlite;
let db: Db;
let seeded: Awaited<ReturnType<typeof seedRehearsal>>;
const html = (machineNo: string, entry: NonNullable<Parameters<typeof ModelDiagramPanel>[0]["entry"]>) =>
  renderToStaticMarkup(createElement(ModelDiagramPanel, { machineNo, entry }));

beforeAll(async () => {
  vi.stubEnv("DIAGRAM_IMPORT_KEY", "");
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  seeded = await seedRehearsal(db);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

describe("one-model diagram import rehearsal: Maytag MVW6230HW1", () => {
  it("saves one row for the exact model from the replayed supplier BOM and the reviewed bundle", async () => {
    expect(seeded.bom.status).toBe("found");
    expect(seeded.bom.winner?.supplier).toBe("appliancepartspros");
    expect(seeded.imported.saved).toBe(true);
    expect(await db.select({ brandKey: schema.modelDiagrams.brandKey, exactModel: schema.modelDiagrams.exactModel }).from(schema.modelDiagrams))
      .toEqual([{ brandKey: "MAYTAG", exactModel: "MVW6230HW1" }]);
  });

  it("shows the diagrams on 6613 and 6601 and links the callout-10 board to its drawing", async () => {
    const [a, b] = await Promise.all(SHOWN.map((m) => rehearsalView(db, m)));
    expect(a.entry).toEqual(b.entry);
    expect(a.entry?.evidence).toMatchObject({ sourceLabel: "AppliancePartsPros source", sourceUrl: "https://www.appliancepartspros.com/parts-for-whirlpool-mvw6230hw1.html" });
    expect(a.entry?.evidence.sections.map((s) => s.assembly)).toEqual([
      "01 - Cover Sheet", "02 - Top And Cabinet", "03 - Console", "04 - Basket And Tub", "05 - Gearcase, Motor And Pump", "06 - Optional Parts (Not Included)"
    ]);
    expect(a.entry?.evidence.sections.reduce((n, s) => n + s.parts.length, 0)).toBe(116);
    for (const view of [a, b]) {
      expect(view.bomRows).toBe(seeded.bom.winner!.rows.length);
      expect(view.boardReferences).toEqual([expect.objectContaining({ assembly: "02 - Top And Cabinet", callout: "10" })]);
    }
  });

  it("stays off adjacent revisions, the other finish and a truncated nameplate, even where they share the part", async () => {
    for (const machineNo of ADJACENT) {
      const view = await rehearsalView(db, machineNo);
      expect(view.entry, machineNo).toBeNull();
      expect(view.records).toEqual([]);
    }
    expect((await rehearsalView(db, "REH-HW0")).boardReferences).toEqual([]);
  });

  it("preserves the four callout-10 records with their sources, showing the observed board only on 6613", async () => {
    const stored = (await getModelDiagrams(db, { brand: "Maytag", modelRaw: "MVW6230HW1" }))!.evidence.calloutRecords!;
    expect(stored.map((r) => [r.role, r.partNumber, r.machineNo])).toEqual([
      ["catalog", "W11479877", null], ["supplier_listed", "W11543994", null], ["observed", "W11538088", "6613"], ["replacement", "W11543994", null]
    ]);
    expect(stored[0].sourceUrl).toBe("https://assets.ajmadison.com/ajmadison/itemdocs/repair-parts-list-w11497934-revb.pdf#page=3");
    expect(stored[1].sourceUrl).toBe("https://www.appliancepartspros.com/02-top-and-cabinet-parts-parts-for-whirlpool-mvw6230hw1.html");
    expect(stored.every((r) => r.assembly === "02 - Top And Cabinet" && r.callout === "10" && r.evidence.length > 20)).toBe(true);

    const [a, b] = await Promise.all(SHOWN.map((m) => rehearsalView(db, m)));
    expect(a.records.map((r) => r.role)).toEqual(["catalog", "supplier_listed", "observed", "replacement"]);
    expect(b.records.map((r) => r.role)).toEqual(["catalog", "supplier_listed", "replacement"]);

    const page6613 = html("6613", a.entry!);
    const page6601 = html("6601", b.entry!);
    expect(page6613).toContain(">AppliancePartsPros source<");
    expect(page6613).toContain("Observed on this machine");
    expect(page6613).toContain("W11538088");
    expect(page6613).toContain('href="https://assets.ajmadison.com/ajmadison/itemdocs/repair-parts-list-w11497934-revb.pdf#page=3"');
    expect(page6601).toContain("W11479877");
    expect(page6601).not.toContain("W11538088");
    expect(page6601).not.toContain("Observed on this machine");
  });

  it("keeps workbook rows labelled as Encompass", () => {
    const legacy = html("1", { sourceSha256: "x", evidence: { sourceUrl: "https://encompass.com/Exploded-View-Assembly/WHI/1/M", sourceNote: "", sections: [] } });
    expect(legacy).toContain(">Encompass source<");
    expect(legacy).not.toContain("Callout evidence");
  });

  it("is idempotent and refuses a stale replacement", async () => {
    const bundle = maytagBundle(seeded.maytag);
    expect(await saveDiagramBundle(db, bundle, "")).toEqual(seeded.imported);
    const changed = { ...bundle, calloutRecords: bundle.calloutRecords!.slice(0, 3) };
    expect((await saveDiagramBundle(db, changed, "0".repeat(64))).saved).toBe(false);
    expect((await getModelDiagrams(db, { brand: "Maytag", modelRaw: "MVW6230HW1" }))!.evidence.calloutRecords).toHaveLength(4);
  });

  it("refuses incomplete, mismatched or misattributed bundles", async () => {
    const bundle = maytagBundle(seeded.maytag);
    expect(() => diagramBundleEvidence({ ...bundle, model: "MVW6230HW0" })).toThrow(DiagramBundleError);
    expect(() => diagramBundleEvidence({ ...bundle, variation: "ABWEVUS" })).toThrow(/not Maytag MVW6230HW1 \(ABWEVUS\)/);
    expect(() => diagramBundleEvidence({ ...bundle, diagrams: { ...bundle.diagrams, outcome: "partial", reason: "1 of 6" } })).toThrow(/partial, not complete/);
    const observed = bundle.calloutRecords!.find((r) => r.role === "observed")!;
    expect(() => diagramBundleEvidence({ ...bundle, calloutRecords: [{ ...observed, machineNo: null }] })).toThrow(/must name the machine/);
    expect(() => diagramBundleEvidence({ ...bundle, calloutRecords: [{ ...observed, assembly: "TOP AND CABINET PARTS" }] })).toThrow(/shown section/);
    await expect(saveDiagramBundle(db, { ...bundle, calloutRecords: [{ ...observed, machineNo: "REH-HW0" }] }, seeded.imported.sourceSha256))
      .rejects.toThrow(/REH-HW0 is not a Maytag MVW6230HW1/);
  });
});
