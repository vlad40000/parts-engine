import { describe, expect, it } from "vitest";
import { applyStep, nextSteps, normalizeMachineNo, parseSoldPrice, type DispositionRecord } from "@/src/lib/part-disposition";

const now = new Date("2026-11-04T15:00:00Z");
const rec = (r: Partial<DispositionRecord> = {}): DispositionRecord => ({ disposition: null, listedAt: null, soldPrice: null, repairMachineNo: null, ...r });

describe("pulled part disposition tree", () => {
  it("offers eBay or Repair from Pulled, Listed or Sold from eBay, Unlisted or Sold from Listed, nothing after Sold or Repair", () => {
    expect(nextSteps(null)).toEqual(["ebay", "repair"]);
    expect(nextSteps("ebay")).toEqual(["listed", "sold"]);
    expect(nextSteps("listed")).toEqual(["unlisted", "sold"]);
    expect(nextSteps("sold")).toEqual([]);
    expect(nextSteps("repair")).toEqual([]);
  });

  it("walks Pulled -> eBay -> Listed -> Sold with a required price", () => {
    expect(applyStep(rec(), "ebay", { now })).toEqual({ kind: "update", record: rec({ disposition: "ebay" }) });
    expect(applyStep(rec({ disposition: "ebay" }), "listed", { now })).toEqual({ kind: "update", record: rec({ disposition: "listed", listedAt: now }) });
    expect(applyStep(rec({ disposition: "listed", listedAt: now }), "sold", { now })).toEqual({ kind: "invalid", reason: "price" });
    expect(applyStep(rec({ disposition: "listed", listedAt: now }), "sold", { now, soldPrice: "$45.5" }))
      .toEqual({ kind: "update", record: rec({ disposition: "sold", soldPrice: "45.50", listedAt: now }) });
    expect(applyStep(rec({ disposition: "ebay" }), "sold", { now, soldPrice: "12" })).toEqual({ kind: "update", record: rec({ disposition: "sold", soldPrice: "12.00" }) });
  });

  it("Unlisted clears the part back onto the machine; only from Listed", () => {
    expect(applyStep(rec({ disposition: "listed", listedAt: now }), "unlisted", { now })).toEqual({ kind: "clear" });
    expect(applyStep(rec({ disposition: "ebay" }), "unlisted", { now })).toEqual({ kind: "invalid", reason: "step" });
  });

  it("Repair requires the recipient Machine ID", () => {
    expect(applyStep(rec(), "repair", { now, repairMachineNo: " " })).toEqual({ kind: "invalid", reason: "machine" });
    expect(applyStep(rec(), "repair", { now, repairMachineNo: "#6171" })).toEqual({ kind: "update", record: rec({ disposition: "repair", repairMachineNo: "6171" }) });
    expect(applyStep(rec({ disposition: "ebay" }), "repair", { now, repairMachineNo: "6171" })).toEqual({ kind: "invalid", reason: "step" });
  });

  it("undo steps back exactly one level", () => {
    expect(applyStep(rec(), "back", { now })).toEqual({ kind: "clear" });
    expect(applyStep(rec({ disposition: "ebay" }), "back", { now })).toEqual({ kind: "update", record: rec() });
    expect(applyStep(rec({ disposition: "repair", repairMachineNo: "6171" }), "back", { now })).toEqual({ kind: "update", record: rec() });
    expect(applyStep(rec({ disposition: "listed", listedAt: now }), "back", { now })).toEqual({ kind: "update", record: rec({ disposition: "ebay" }) });
    expect(applyStep(rec({ disposition: "sold", soldPrice: "5.00", listedAt: now }), "back", { now })).toEqual({ kind: "update", record: rec({ disposition: "listed", listedAt: now }) });
    expect(applyStep(rec({ disposition: "sold", soldPrice: "5.00" }), "back", { now })).toEqual({ kind: "update", record: rec({ disposition: "ebay" }) });
  });

  it("parses prices and machine IDs", () => {
    expect(["45", "45.5", "$1,234.567", ".5", "0"].map(parseSoldPrice)).toEqual(["45.00", "45.50", "1234.57", "0.50", "0.00"]);
    expect(["", "-1", "abc", "1e3", "100000000"].map(parseSoldPrice)).toEqual([null, null, null, null, null]);
    expect([" # 6171 ", "", "A-12"].map(normalizeMachineNo)).toEqual(["6171", null, "A-12"]);
  });
});
