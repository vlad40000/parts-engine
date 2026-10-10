import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { getSettings, hasEligibleModelDonor, modelsNeedingBom, mpnDetail, mpnIndex, saveModelBom, saveSettings, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { parseCsvRows } from "@/src/lib/csv";
import { GET as exportDonors } from "@/app/api/export/mpn-donors/route";
import { POST as runBom } from "@/app/api/bom/model/route";
import MpnPage from "@/app/mpns/[mpn]/page";
import type { ChainResult } from "@/src/sources/chain";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));

let db: Db;
const MPN = "W11165528";
const row = (id: number, status: string, model = "WTW1111") => ({
  ID: id, Availability: status, ApplianceType: "Washer", Brand: "Whirlpool", ModelNumber: model, SerialNumber: ""
});
const result: ChainResult = {
  status: "found",
  winner: { supplier: "encompass", status: "found", rows: [{ mpnDisplay: MPN, mpnCanonical: MPN, description: "Control Board", diagramId: "1", supplierPartId: null, newPrice: 80, nla: false }], droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: []
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    ...Array.from({ length: 30 }, (_, i) => row(1000 + i, "PARTS ONLY")),
    ...Array.from({ length: 20 }, (_, i) => row(2000 + i, "NEEDS PARTS", "WTW2222")),
    row(3000, "UNCHECKED", "WTW3333"), row(4000, "SOLD", "WTW4444"),
    row(4001, "SCRAPED", "WTW4444"), row(4002, "SCRAPPED", "WTW4444")
  ]).rows);
});

describe("donor status at lookup and in existing BOM cross-reference", () => {
  it("requires explicit UNCHECKED selection and never accepts off-lot statuses, even if configured", async () => {
    const s = await getSettings(db);
    await saveSettings(db, { ...s, donorAvailabilities: [...s.donorAvailabilities, "SOLD", "SCRAPED", "SCRAPPED"] });
    const allowed = (await getSettings(db)).donorAvailabilities;
    expect(allowed).not.toEqual(expect.arrayContaining(["SOLD", "SCRAPED", "SCRAPPED"]));
    expect((await modelsNeedingBom(db, {}, allowed)).map((x) => x.model_key)).toEqual(["WTW1111", "WTW2222"]);
    expect((await modelsNeedingBom(db, { availability: "UNCHECKED" }, allowed)).map((x) => x.model_key)).toEqual(["WTW3333"]);
    expect((await modelsNeedingBom(db, { availability: "include_unchecked" }, allowed)).map((x) => x.model_key)).toEqual(["WTW1111", "WTW2222", "WTW3333"]);
    expect(await modelsNeedingBom(db, { availability: "SOLD" }, allowed)).toEqual([]);
    expect(await hasEligibleModelDonor(db, "WHIRLPOOL", "WTW3333", allowed)).toBe(false);
    expect(await hasEligibleModelDonor(db, "WHIRLPOOL", "WTW3333", allowed, "UNCHECKED")).toBe(true);
    expect(await hasEligibleModelDonor(db, "WHIRLPOOL", "WTW3333", allowed, "include_unchecked")).toBe(true);
    for (const status of ["SOLD", "SCRAPED", "SCRAPPED"]) {
      expect(await hasEligibleModelDonor(db, "WHIRLPOOL", "WTW4444", allowed, status)).toBe(false);
      const response = await runBom(new Request("http://local/api/bom/model", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ brand: "Whirlpool", model: "WTW4444", availability: status })
      }));
      expect(response.status).toBe(409);
    }
  });

  it("lists and exports all 50 checked donors across two cached model BOMs", async () => {
    for (const model of ["WTW1111", "WTW2222", "WTW3333", "WTW4444"]) {
      await saveModelBom(db, { brandKey: "WHIRLPOOL", modelKey: model, brandDisplay: "Whirlpool", modelDisplay: model, result });
    }
    const detail = (await mpnDetail(db, MPN, "eligible"))!;
    expect(detail.mpn.donors).toBe(50);
    expect(detail.machines).toHaveLength(50);
    expect(new Set(detail.machines.map((x) => x.model_key))).toEqual(new Set(["WTW1111", "WTW2222"]));
    expect((await mpnIndex(db, { view: "all" })).rows.find((x) => x.mpn_canonical === MPN)?.donors).toBe(50);
    const html = renderToStaticMarkup(await MpnPage({
      params: Promise.resolve({ mpn: MPN }), searchParams: Promise.resolve({ availability: "eligible" })
    }));
    expect(html).toContain("Machine compatibility cross-reference");
    expect(html.match(/href="\/machines\//g)).toHaveLength(50);
    expect(html).toContain("/api/export/mpn-donors?mpn=W11165528&amp;availability=eligible");

    const res = await exportDonors(new Request(`http://local/api/export/mpn-donors?mpn=${MPN}`));
    expect(res.status).toBe(200);
    const rows = parseCsvRows(await res.text());
    expect(rows).toHaveLength(51);
    expect(new Set(rows.slice(1).map((x) => x[1])).size).toBe(50);
    expect(rows.slice(1).every((x) => x[3] === "harvest_candidate")).toBe(true);
  });

  it("keeps unchecked as inspection-first and sold/scrap as historical only; a later sale removes a donor", async () => {
    const unchecked = (await mpnDetail(db, MPN, "UNCHECKED"))!;
    expect(unchecked.machines.map((x) => x.machine_no)).toEqual(["3000"]);
    expect(unchecked.harvest.testFirst.map((x) => x.machine_no)).toEqual(["3000"]);
    const combined = (await mpnDetail(db, MPN, "include_unchecked"))!;
    expect(combined.machines).toHaveLength(51);
    expect(combined.harvest.testFirst.map((x) => x.machine_no)).toEqual(["3000"]);
    for (const status of ["SOLD", "SCRAPED", "SCRAPPED"]) {
      const historical = (await mpnDetail(db, MPN, status))!;
      expect(historical.harvest.unavailable).toHaveLength(1);
      expect(historical.harvest.harvestCandidates).toHaveLength(0);
    }
    await upsertFleet(db, mapFleetRows([row(1000, "SOLD")]).rows);
    expect((await mpnDetail(db, MPN, "eligible"))!.machines).toHaveLength(49);
    expect((await mpnDetail(db, MPN, "all"))!.machines).toHaveLength(54);
    expect((await mpnDetail(db, MPN, "SOLD"))!.harvest.unavailable).toHaveLength(2);
  });
});
