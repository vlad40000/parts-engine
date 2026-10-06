import { describe, expect, it } from "vitest";
import { classifyComponent, classifyFamily, libraryAppliance, suspectFamilies } from "@/src/lib/part-family";
import { resolveRemoval, SEED_BASELINES } from "@/src/lib/removal";

describe("part families", () => {
  it.each([
    ["Dishwasher Main Control Board", "control_board"],
    ["Washer User Interface Board", "ui_panel"],
    ["Dishwasher Drain Pump And Motor Kit", "pump"],
    ["Dishwasher Door Gasket", "gasket_seal"],
    ["Dishwasher HEX HEAD SCREW 8-16 1/2 STAINLESS STEEL", "fastener"],
    ["Use and Care Manual", "literature"],
    ["Compressor", "compressor"],
    ["Compressor Start Relay", "sensor_switch"],
    ["Water Inlet Valve & Harness", "valve"]
  ])("%s → %s", (d, f) => expect(classifyFamily(d)).toBe(f));
});

describe("removal component + minutes", () => {
  it("maps appliance types", () => {
    expect(libraryAppliance("Washer - Top Load / No Agitator")).toBe("Washer");
    expect(libraryAppliance("Dryer - Electric")).toBe("Dryer");
    expect(libraryAppliance("Refrigerator - French")).toBe("Refrigerator");
    expect(libraryAppliance("Range - Glass Top")).toBe("Range");
    expect(libraryAppliance("Dishwasher")).toBe("Dishwasher");
  });
  it("washer control board → 10 min generic", () => {
    expect(classifyComponent("Washer", "Washer Electronic Control Board")).toBe("Main control board / ACU");
    const r = resolveRemoval({ mpnCanonical: "X1", appliance: "Washer", description: "Washer Electronic Control Board", baselines: SEED_BASELINES });
    expect(r).toMatchObject({ minutes: 10, source: "generic" });
  });
  it("researched override beats generic", () => {
    const r = resolveRemoval({ mpnCanonical: "W11305293", appliance: "Dishwasher", description: "Control board", baselines: SEED_BASELINES });
    expect(r).toMatchObject({ minutes: 15, source: "researched" });
  });
  it("dishwasher has no generic baseline → null (NEEDS_DATA, no invented minutes)", () => {
    const r = resolveRemoval({ mpnCanonical: "X2", appliance: "Dishwasher", description: "Drain pump", baselines: SEED_BASELINES });
    expect(r.minutes).toBeNull();
  });
});

describe("failure symptoms", () => {
  it("maps diagnosis text to suspect families", () => {
    expect(suspectFamilies("Won't drain")).toContain("pump");
    expect(suspectFamilies("No power, dead")).toContain("control_board");
    expect(suspectFamilies("")).toEqual([]);
  });
});

describe("word-boundary family rules", () => {
  it.each([
    ["Laundry Center Cabinet", "door_panel"],
    ["Spring Tension Hose Clamp", "fastener"],
    ["Drawer Slide Rail", "rack_bin"],
    ["Appliance Name Plate", "literature"],
    ["Washer Lid Hinge", "door_panel"]
  ])("%s → %s", (d, f) => expect(classifyFamily(d)).toBe(f));
});
