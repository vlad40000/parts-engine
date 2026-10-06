import type { LibraryAppliance } from "./part-family";

/**
 * Harvested-part planning economics and qualification (Roadrunner Store Economics v7).
 *
 * There is no general minimum part price: the floor is the per-part break-even.
 * Exact-MPN 90-day sell-through is a research/manual input and is never derived here.
 * Qualification stays SET_RULE until the owner enters both minimum thresholds.
 * Percent settings use app percent units: 13.6 means 13.6%. Every number comes from settings.
 */

export type OverheadAppliance = "Refrigerator" | "Washer" | "Range" | "Dryer" | "Dishwasher";
export const OVERHEAD_APPLIANCES: OverheadAppliance[] = ["Refrigerator", "Washer", "Range", "Dryer", "Dishwasher"];

export type EconomicsSettings = {
  finalValueFeePct: number;
  promotedListingPct: number;
  marketplaceTaxPct: number;
  perOrderFee: number;
  defaultShipLabel: number;
  packShipLabor: number;
  /** Non-management operations labor $/hour (management labor is not charged per part). */
  laborRateHr: number;
  ordinarySold90Minimum: number;
  /** Owner-set; null until entered. */
  minimumSellThroughPct: number | null;
  /** Owner-set; null until entered. */
  minimumProfitMarginPct: number | null;
  /** Machine-type overhead per quick-sale harvested part. */
  harvestOverhead: Record<OverheadAppliance, number> & { fallback: number };
};

export function machineOverheadFor(appliance: LibraryAppliance, s: EconomicsSettings): { amount: number; basis: OverheadAppliance | "fallback" } {
  const known = OVERHEAD_APPLIANCES.find((a) => a === appliance);
  return known ? { amount: s.harvestOverhead[known], basis: known } : { amount: s.harvestOverhead.fallback, basis: "fallback" };
}

export type PartEconomicsInput = {
  /** Expected/average sold item price. */
  P: number | null;
  /** Buyer shipping collected; null = unknown. */
  B: number | null;
  /** Listing offers free shipping, so the buyer pays no shipping. */
  freeShipping: boolean;
  /** Seller shipping-label cost; null = use the default label. */
  S: number | null;
  removalMin: number | null;
  packagingCost: number | null;
  appliance: LibraryAppliance;
};

export type PartEconomics = {
  P: number;
  B: number;
  buyerShippingBasis: "market" | "free_shipping" | "label_estimate";
  S: number;
  shipLabelBasis: "market" | "default";
  fees: number;
  packShipLabor: number;
  packaging: number;
  removalLabor: number;
  machineOverhead: number;
  overheadBasis: OverheadAppliance | "fallback";
  /** Projected harvested-part contribution after the costs tied to the part. */
  contribution: number;
  /** Projected profit margin %, contribution / (P + B). Null when P + B is zero. */
  marginPct: number | null;
  /** Per-part break-even item price. Null when fee rates leave nothing per dollar of price. */
  breakEven: number | null;
  /** P − break-even. */
  overBreakEven: number | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Null when price or removal minutes are unknown: those have no documented fallback. */
export function partEconomics(input: PartEconomicsInput, s: EconomicsSettings): PartEconomics | null {
  if (input.P == null || input.removalMin == null) return null;
  const P = input.P;
  const S = input.S ?? s.defaultShipLabel;
  const shipLabelBasis = input.S != null ? "market" : "default";
  // Buyer shipping is revenue; unknown buyer shipping is planned at the label estimate.
  const B = input.freeShipping ? 0 : input.B ?? S;
  const buyerShippingBasis = input.freeShipping ? "free_shipping" : input.B != null ? "market" : "label_estimate";

  const taxedFvf = (1 + s.marketplaceTaxPct / 100) * (s.finalValueFeePct / 100);
  const promo = s.promotedListingPct / 100;
  const fees = (P + B) * taxedFvf + P * promo + s.perOrderFee;
  const removalLabor = (input.removalMin * s.laborRateHr) / 60;
  const packaging = input.packagingCost ?? 0;
  const overhead = machineOverheadFor(input.appliance, s);

  const contribution = P + B - fees - S - s.packShipLabor - packaging - removalLabor - overhead.amount;
  const marginPct = P + B > 0 ? (contribution / (P + B)) * 100 : null;
  const denominator = 1 - taxedFvf - promo;
  const breakEven = denominator > 0
    ? Math.max(0, (s.perOrderFee + S + s.packShipLabor + removalLabor + overhead.amount + packaging - B * (1 - taxedFvf)) / denominator)
    : null;

  return {
    P, B, buyerShippingBasis, S, shipLabelBasis,
    fees: round2(fees),
    packShipLabor: s.packShipLabor,
    packaging: round2(packaging),
    removalLabor: round2(removalLabor),
    machineOverhead: overhead.amount,
    overheadBasis: overhead.basis,
    contribution: round2(contribution),
    marginPct: marginPct == null ? null : round2(marginPct),
    breakEven: breakEven == null ? null : round2(breakEven),
    overBreakEven: breakEven == null ? null : round2(P - breakEven)
  };
}

/**
 * Modeled value per slot-day = (P − break-even) × exact sell-through / 90.
 * A ranking metric from the v7 workbook, not a probability. Null without exact sell-through.
 */
export function modeledValueSlotDay(economics: PartEconomics | null, sellThroughPct: number | null): number | null {
  if (!economics || economics.overBreakEven == null || sellThroughPct == null) return null;
  return round4((economics.overBreakEven * (sellThroughPct / 100)) / 90);
}

export type QualificationGate = "sold_count" | "sell_through" | "break_even" | "profit_margin";

export type QualificationInput = PartEconomicsInput & {
  sold90: number | null;
  /** Exact-MPN 90-day sell-through %, from research or manual entry only. */
  sellThroughPct: number | null;
  strategicExceptionApproved: boolean;
};

type Common = { economics: PartEconomics | null; modeledValueSlotDay: number | null };
export type Qualification =
  | (Common & { result: "SET_RULE"; missingRules: Array<"minimum_sell_through" | "minimum_profit_margin"> })
  | (Common & { result: "NEEDS_DATA"; missing: string[] })
  | (Common & { result: "QUALIFIED"; economics: PartEconomics; reasons: string[] })
  | (Common & { result: "NOT_QUALIFIED"; economics: PartEconomics; failed: QualificationGate[]; reasons: string[] });

const money = (n: number) => `$${n.toFixed(2)}`;

export function qualify(input: QualificationInput, s: EconomicsSettings): Qualification {
  const economics = partEconomics(input, s);
  const common: Common = { economics, modeledValueSlotDay: modeledValueSlotDay(economics, input.sellThroughPct) };

  // Never fall back to a default threshold: no rule, no verdict.
  const missingRules: Array<"minimum_sell_through" | "minimum_profit_margin"> = [];
  if (s.minimumSellThroughPct == null) missingRules.push("minimum_sell_through");
  if (s.minimumProfitMarginPct == null) missingRules.push("minimum_profit_margin");
  if (missingRules.length) return { ...common, result: "SET_RULE", missingRules };

  const missing: string[] = [];
  if (input.P == null) missing.push("price");
  if (input.removalMin == null) missing.push("removal_minutes");
  if (input.sellThroughPct == null) missing.push("sell_through");
  if (input.sold90 == null && !input.strategicExceptionApproved) missing.push("sold_90");
  if (missing.length || !economics) return { ...common, result: "NEEDS_DATA", missing };

  const minStr = s.minimumSellThroughPct as number;
  const minMargin = s.minimumProfitMarginPct as number;
  const sellThrough = input.sellThroughPct as number;
  const failed: QualificationGate[] = [];
  const reasons: string[] = [];

  if (input.strategicExceptionApproved) {
    reasons.push("Strategic exception approved: the 90-day sold-count minimum is waived.");
  } else if ((input.sold90 as number) < s.ordinarySold90Minimum) {
    failed.push("sold_count");
    reasons.push(`Sold ${input.sold90} in 90 days, below the ordinary minimum of ${s.ordinarySold90Minimum}.`);
  }
  if (sellThrough < minStr) {
    failed.push("sell_through");
    reasons.push(`Sell-through ${sellThrough}% is below ${minStr}%.`);
  }
  if (economics.breakEven == null || economics.P < economics.breakEven) {
    failed.push("break_even");
    reasons.push(economics.breakEven == null
      ? "Fee rates leave no break-even price."
      : `Price ${money(economics.P)} is below the ${money(economics.breakEven)} break-even.`);
  }
  if (economics.marginPct == null || economics.marginPct < minMargin) {
    failed.push("profit_margin");
    reasons.push(`Projected margin ${economics.marginPct ?? "n/a"}% is below ${minMargin}%.`);
  }
  if (failed.length) return { ...common, result: "NOT_QUALIFIED", economics, failed, reasons };
  return {
    ...common, result: "QUALIFIED", economics,
    reasons: [...reasons, `Margin ${economics.marginPct}%, ${money(economics.overBreakEven as number)} over break-even, sell-through ${sellThrough}%.`]
  };
}
