import { describe, expect, it } from "vitest";
import { modeledValueSlotDay, partEconomics, qualify, type EconomicsSettings, type QualificationInput } from "@/src/lib/economics";

// v7 workbook defaults; the two owner thresholds start unset.
const V7: EconomicsSettings = {
  finalValueFeePct: 13.6, promotedListingPct: 3.62, marketplaceTaxPct: 6.56, perOrderFee: 0.4,
  defaultShipLabel: 9, packShipLabor: 1.5, laborRateHr: 15, ordinarySold90Minimum: 3,
  minimumSellThroughPct: null, minimumProfitMarginPct: null,
  harvestOverhead: { Refrigerator: 3.48, Washer: 4.65, Range: 5.07, Dryer: 5.43, Dishwasher: 5.91, fallback: 5.07 }
};
// Test-only thresholds. These are not owner values; the app ships them blank.
const RULES: EconomicsSettings = { ...V7, minimumSellThroughPct: 30, minimumProfitMarginPct: 25 };

const input = (patch: Partial<QualificationInput> = {}): QualificationInput => ({
  P: 60, B: null, freeShipping: false, S: null, removalMin: 20, packagingCost: null, appliance: "Washer",
  sold90: 10, sellThroughPct: 40, strategicExceptionApproved: false, ...patch
});

describe("v7 qualification rules", () => {
  it("1. both thresholds unset → SET_RULE, even for a strong part; economics still computed", () => {
    const q = qualify(input({ P: 500 }), V7);
    expect(q).toMatchObject({ result: "SET_RULE", missingRules: ["minimum_sell_through", "minimum_profit_margin"] });
    expect(q.economics?.breakEven).toBe(15.7);
    expect(qualify(input(), { ...V7, minimumSellThroughPct: 30 })).toMatchObject({ result: "SET_RULE", missingRules: ["minimum_profit_margin"] });
    expect(qualify(input(), { ...V7, minimumProfitMarginPct: 25 })).toMatchObject({ result: "SET_RULE", missingRules: ["minimum_sell_through"] });
  });

  it("12. missing exact sell-through → NEEDS_DATA once rules are set (sold90/active never substitute)", () => {
    expect(qualify(input({ sellThroughPct: null }), RULES)).toMatchObject({ result: "NEEDS_DATA", missing: ["sell_through"] });
    expect(qualify(input({ P: null, removalMin: null, sold90: null, sellThroughPct: null }), RULES))
      .toMatchObject({ result: "NEEDS_DATA", missing: ["price", "removal_minutes", "sell_through", "sold_90"] });
  });

  it("7. ordinary sold-count gate is 3; a strategic exception overrides only that gate", () => {
    expect(qualify(input({ sold90: 3 }), RULES).result).toBe("QUALIFIED");
    expect(qualify(input({ sold90: 2 }), RULES)).toMatchObject({ result: "NOT_QUALIFIED", failed: ["sold_count"] });
    expect(qualify(input({ sold90: 2, strategicExceptionApproved: true }), RULES).result).toBe("QUALIFIED");
    // Unknown sold count is waived by the exception too, but nothing else is.
    expect(qualify(input({ sold90: null, strategicExceptionApproved: true }), RULES).result).toBe("QUALIFIED");
    expect(qualify(input({ sold90: 0, strategicExceptionApproved: true, sellThroughPct: 10 }), RULES))
      .toMatchObject({ result: "NOT_QUALIFIED", failed: ["sell_through"] });
    expect(qualify(input({ sold90: 0, strategicExceptionApproved: true, P: 10 }), RULES))
      .toMatchObject({ result: "NOT_QUALIFIED", failed: ["break_even", "profit_margin"] });
  });

  it("13. price/profit gate is minimum margin %, not flat minimum-profit dollars", () => {
    // Washer, P 60: margin 52.58%.
    expect(qualify(input(), { ...RULES, minimumProfitMarginPct: 52.5 }).result).toBe("QUALIFIED");
    expect(qualify(input(), { ...RULES, minimumProfitMarginPct: 52.6 })).toMatchObject({ result: "NOT_QUALIFIED", failed: ["profit_margin"] });
    // Above break-even with healthy dollars can still fail on margin; the reverse is decided by margin too.
    const thin = qualify(input({ P: 20 }), { ...RULES, minimumProfitMarginPct: 25 });
    expect(thin).toMatchObject({ result: "NOT_QUALIFIED", failed: ["profit_margin"] });
    expect(thin.economics!.contribution).toBeGreaterThan(1);
    expect(thin.economics!.P).toBeGreaterThan(thin.economics!.breakEven!);
  });

  it("price below the per-part break-even fails the break-even gate", () => {
    expect(qualify(input({ P: 15 }), { ...RULES, minimumProfitMarginPct: 0 })).toMatchObject({ result: "NOT_QUALIFIED", failed: ["break_even", "profit_margin"] });
    expect(qualify(input({ P: 15.7 }), { ...RULES, minimumProfitMarginPct: -100 }).result).toBe("QUALIFIED");
  });

  it("returns explicit reasons", () => {
    const q = qualify(input({ sold90: 1, sellThroughPct: 12 }), RULES);
    expect(q.result === "NOT_QUALIFIED" && q.reasons).toEqual([
      "Sold 1 in 90 days, below the ordinary minimum of 3.", "Sell-through 12% is below 30%."
    ]);
  });
});

describe("v7 harvested-part planning economics", () => {
  it("8. break-even matches the v7 formula by machine type (P 60, 20 min, label $9, buyer shipping unknown)", () => {
    // Reference values computed by hand from the v7 Harvest Economics algebra.
    const cases: Array<[QualificationInput["appliance"], number, number, number]> = [
      ["Refrigerator", 14.27, 37.45, 54.27],
      ["Washer", 15.7, 36.28, 52.58],
      ["Range", 16.21, 35.86, 51.97],
      ["Dryer", 16.65, 35.5, 51.45],
      ["Dishwasher", 17.24, 35.02, 50.75]
    ];
    for (const [appliance, breakEven, contribution, marginPct] of cases) {
      const e = partEconomics(input({ appliance }), V7)!;
      expect({ appliance, breakEven: e.breakEven, contribution: e.contribution, marginPct: e.marginPct, fees: e.fees })
        .toEqual({ appliance, breakEven, contribution, marginPct, fees: 12.57 });
      // At the break-even price the contribution is zero.
      expect(Math.abs(partEconomics(input({ appliance, P: breakEven }), V7)!.contribution)).toBeLessThanOrEqual(0.01);
    }
    // Unresolved appliance types use the fallback overhead.
    expect(partEconomics(input({ appliance: "Microwave" }), V7)).toMatchObject({ machineOverhead: 5.07, overheadBasis: "fallback", breakEven: 16.21 });
    expect(partEconomics(input({ appliance: "Other" }), V7)?.overheadBasis).toBe("fallback");
  });

  it("9. removal labor at 20 minutes is exactly $5 at $15/hour", () => {
    expect(partEconomics(input({ removalMin: 20 }), V7)?.removalLabor).toBe(5);
  });

  it("10. buyer-paid shipping is revenue while the shipping label stays a seller cost", () => {
    const paid = partEconomics(input({ B: 12, S: 9 }), V7)!;
    expect(paid).toMatchObject({ B: 12, buyerShippingBasis: "market", S: 9, shipLabelBasis: "market", contribution: 38.84, breakEven: 12.56 });
    const free = partEconomics(input({ B: 12, S: 9, freeShipping: true }), V7)!;
    expect(free).toMatchObject({ B: 0, buyerShippingBasis: "free_shipping", S: 9, contribution: 28.58, breakEven: 25.1 });
    // Unknown buyer shipping is planned at the label estimate; unknown label uses the default.
    expect(partEconomics(input({ B: null, S: 14 }), V7)).toMatchObject({ B: 14, buyerShippingBasis: "label_estimate", S: 14 });
    expect(partEconomics(input({ B: 7, S: null }), V7)).toMatchObject({ B: 7, S: 9, shipLabelBasis: "default" });
  });

  it("11. projected margin uses contribution after overhead, removal and fulfillment costs", () => {
    const e = partEconomics(input({ B: 9, S: 9, packagingCost: 2 }), V7)!;
    const expected = 60 + 9 - e.fees - 9 - 1.5 - 2 - 5 - 4.65;
    expect(e.contribution).toBeCloseTo(expected, 1);
    expect(e.marginPct).toBeCloseTo((e.contribution / 69) * 100, 1);
    // Blank packaging is planned as $0.
    expect(partEconomics(input({ packagingCost: null }), V7)?.packaging).toBe(0);
    expect(partEconomics(input({ packagingCost: 2 }), V7)!.contribution).toBe(36.28 - 2);
  });

  it("14. modeled value / slot-day uses exact sell-through only", () => {
    const e = partEconomics(input({ appliance: "Refrigerator" }), V7)!;
    expect(e.overBreakEven).toBe(45.73);
    expect(modeledValueSlotDay(e, 40)).toBeCloseTo((45.73 * 0.4) / 90, 4);
    expect(modeledValueSlotDay(e, null)).toBeNull();
    // The qualification input has no active-listing field at all; sold90 does not move the metric.
    const a = qualify(input({ sold90: 5 }), RULES).modeledValueSlotDay;
    const b = qualify(input({ sold90: 500 }), RULES).modeledValueSlotDay;
    expect(a).toBe(b);
    expect(qualify(input({ sellThroughPct: null }), RULES).modeledValueSlotDay).toBeNull();
  });

  it("price or removal minutes unknown → no economics (no fallback exists)", () => {
    expect(partEconomics(input({ P: null }), V7)).toBeNull();
    expect(partEconomics(input({ removalMin: null }), V7)).toBeNull();
  });
});
