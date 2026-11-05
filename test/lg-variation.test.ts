import { describe, expect, it } from "vitest";
import { lgIdentity, lgVariation, splitLgModel, variationFromProductCode } from "@/src/lib/lg-variation";
import { mapFleetRows } from "@/src/lib/fleet-import";

describe("LG manufacturer variation identity", () => {
  it("keeps manufacturer variation separate from model revision and serial", () => {
    expect(lgIdentity("LG", "WT7200CW", "ABWEVUS")).toEqual({ modelKey: "WT7200CW|ABWEVUS", identityStatus: "ok" });
    expect(lgIdentity("LG", "WT7200CW", "ABWETUS").modelKey).not.toBe(lgIdentity("LG", "WT7200CW", "ABWEVUS").modelKey);
    expect(lgIdentity("LG", "WT7200CW/00", "ABWEVUS").modelKey).toBe("WT7200CW/00|ABWEVUS");
    expect(lgIdentity("LG", "WT7200CW", null).identityStatus).toBe("needs_variation");
    expect(lgIdentity("Maytag", "MVWX655DW1", null)).toEqual({ modelKey: "MVWX655DW1", identityStatus: "ok" });
  });
  it("reads a variation from the model or nameplate product code without assuming the serial supplies it", () => {
    expect(splitLgModel("WT7200CW.ABWEVUS")).toEqual({ model: "WT7200CW", variation: "ABWEVUS" });
    expect(variationFromProductCode("T1780WFFV.ABWEVUS")).toBe("ABWEVUS");
    expect(lgVariation("ABW-EVUS")).toBeNull();
    const rows = mapFleetRows([{ ID: "9998", Brand: "LG", ModelNumber: "WT7200CW", SerialNumber: "EXAMPLE",
      "Product Code": "T1780WFFV.ABWEVUS" }]).rows;
    expect(rows[0]).toMatchObject({ manufacturerVariation: "ABWEVUS", productCode: "T1780WFFV.ABWEVUS", modelKey: "WT7200CW|ABWEVUS", identityStatus: "ok" });
  });
  it("marks unknown or conflicting variants for verification and never guesses from nearby models", () => {
    const result = mapFleetRows([
      { ID: "1", Brand: "LG", ModelNumber: "WT7200CW", SerialNumber: "SYNTHETIC" },
      { ID: "2", Brand: "LG", ModelNumber: "WT7200CW.ABWEVUS", "Product Code": "T1780WFFV.ABWETUS" },
      { ID: "3", Brand: "LG", ModelNumber: "WT7200CW.ABWEVUS" }
    ]);
    expect(result.rows.map((r) => r.identityStatus)).toEqual(["needs_variation", "needs_variation", "ok"]);
    expect(result.rows[1].manufacturerVariation).toBeNull();
    expect(result.rows[2].modelKey).toBe("WT7200CW|ABWEVUS");
  });
});
