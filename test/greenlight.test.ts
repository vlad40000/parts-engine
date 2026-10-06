import { describe, expect, it } from "vitest";
import { greenlight, minGreenlightPrice, rankScore, type GreenlightSettings } from "@/src/lib/greenlight";

const s: GreenlightSettings = { feePct: 25, minSellThroughPct: 20, harvestCushion: 20, minProfit: 1, laborRateHr: 15 };
const base = { B: 12, freeShipping: false, S: 0, removalMin: 15, sellThrough90: 30, settings: s };

describe("greenlight — handoff §4.2 matrix", () => {
  it("worked check at P = 37.00 → GREENLIGHT, profit 1.00", () => {
    const g = greenlight({ ...base, P: 37 });
    expect(g).toMatchObject({ verdict: "GREENLIGHT", profit: 1 });
  });
  it("same at P = 36.99 → REJECT profit", () => {
    const g = greenlight({ ...base, P: 36.99 });
    expect(g).toMatchObject({ verdict: "REJECT", failed: ["profit"] });
  });
  it("sell-through 19.99% at P = 100 → REJECT sell_through", () => {
    const g = greenlight({ ...base, P: 100, sellThrough90: 19.99 });
    expect(g).toMatchObject({ verdict: "REJECT", failed: ["sell_through"] });
  });
  it("free shipping, S = 0 → NEEDS_DATA ship_cost", () => {
    const g = greenlight({ ...base, P: 80, freeShipping: true, S: 0 });
    expect(g).toEqual({ verdict: "NEEDS_DATA", missing: ["ship_cost"] });
  });
  it("free shipping, S = 14, P = 80, 10 min → fee on P only, profit 23.50", () => {
    const g = greenlight({ ...base, P: 80, freeShipping: true, S: 14, removalMin: 10 });
    expect(g).toMatchObject({ verdict: "GREENLIGHT", profit: 23.5 });
  });
  it("new part C = 20, label 2 min, P = 40, buyer ship 10 → profit 7.00, no cushion", () => {
    const g = greenlight({ ...base, P: 40, B: 10, isNew: true, C: 20, labelMin: 2, removalMin: null });
    expect(g).toMatchObject({ verdict: "GREENLIGHT", profit: 7 });
  });
  it("removalMin null, harvested → NEEDS_DATA", () => {
    const g = greenlight({ ...base, P: 50, removalMin: null });
    expect(g).toEqual({ verdict: "NEEDS_DATA", missing: ["removal_minutes"] });
  });
});

describe("prefilter + ranking", () => {
  it("min price for 15 min with B = 0", () => {
    expect(minGreenlightPrice(15, s)).toBe(33);
  });
  it("rank sets order only; share caps at 1", () => {
    expect(rankScore(10, 90, 30)).toMatchObject({ score: 10, share: 1 });
    expect(rankScore(10, 45, 90)).toMatchObject({ score: 2.5, share: 0.5 });
    expect(rankScore(10, 45, null).flags).toContain("no_active_count");
  });
});
