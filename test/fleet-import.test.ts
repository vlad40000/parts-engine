import { describe, expect, it } from "vitest";
import { mapFleetRows, parseCsv } from "@/src/lib/fleet-import";

const NOW = new Date("2026-10-06T12:00:00Z");

describe("fleet import", () => {
  it("allow-lists columns and never reads purchaser fields", () => {
    const res = mapFleetRows([
      { ID: 1, Availability: "UNCHECKED", ApplianceType: "Dishwasher", Brand: "GE", ModelNumber: "GDT535PSJ2SS", SerialNumber: "SL621054Q", PurchaserName: "Jane Doe", PurchaserPhone: "555", Diagnosis: "won't drain" },
      { ID: 2, Availability: "PARTS ONLY", ApplianceType: "Range - Drop In", Brand: "GE", ModelNumber: "NO NAMEPLATE", SerialNumber: "" },
      { ID: 1, Brand: "GE", ModelNumber: "dup" }
    ], NOW);
    expect(res.rows).toHaveLength(2);
    expect(JSON.stringify(res.rows)).not.toContain("Jane");
    expect(res.ignoredColumns).toEqual(expect.arrayContaining(["PurchaserName", "PurchaserPhone"]));
    expect(res.duplicates).toEqual(["1"]);
    const [a, b] = res.rows;
    expect(a).toMatchObject({ machineNo: "1", brandKey: "GE", modelKey: "GDT535PSJ2SS", ageConfidence: "ambiguous", identityStatus: "ok" });
    expect(a.suspectFamilies).toContain("pump");
    expect(b).toMatchObject({ identityStatus: "needs_nameplate", modelKey: "" });
  });

  it("reads the 225–282 CSV shape", () => {
    const rows = parseCsv('No.,Appliance Type,Brand,Model,Serial,Color,Notes\n225,Dryer - Electric,GE,GTD42EASJ2WW,"ZS123456G",White,"has, comma"\n');
    const res = mapFleetRows(rows, NOW);
    expect(res.rows[0]).toMatchObject({ machineNo: "225", notes: "has, comma", modelKey: "GTD42EASJ2WW" });
  });
});
