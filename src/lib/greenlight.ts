/**
 * greenlight() — the binary listing rule (handoff D3–D9).
 *   harvested:  P − F − S − L − cushion ≥ minProfit
 *   new stock:  P − F − S − C − Llabel ≥ minProfit
 *   and 90-day sell-through ≥ minSellThrough
 * F = feePct × (freeShipping ? P : P + B).  L = minutes × rate / 60.
 * Every number comes from settings. No literals.
 */

export type GreenlightSettings = {
  feePct: number;
  minSellThroughPct: number;
  harvestCushion: number;
  minProfit: number;
  laborRateHr: number;
};

export type GreenlightInput = {
  P: number | null;
  B: number | null;
  freeShipping: boolean;
  S: number | null;
  removalMin: number | null;
  isNew?: boolean;
  C?: number | null;
  labelMin?: number | null;
  sellThrough90: number | null;
  settings: GreenlightSettings;
};

export type Greenlight =
  | { verdict: "GREENLIGHT"; profit: number; reasons: string[] }
  | { verdict: "REJECT"; profit: number | null; failed: Array<"sell_through" | "profit">; reasons: string[] }
  | { verdict: "NEEDS_DATA"; missing: string[] };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function greenlight(input: GreenlightInput): Greenlight {
  const { settings: s } = input;
  const missing: string[] = [];
  if (input.P == null) missing.push("price");
  if (input.sellThrough90 == null) missing.push("sell_through");
  if (input.isNew) {
    if (input.C == null) missing.push("landed_cost");
  } else if (input.removalMin == null) {
    missing.push("removal_minutes");
  }
  if (input.freeShipping && !(input.S != null && input.S > 0)) missing.push("ship_cost");
  if (missing.length) return { verdict: "NEEDS_DATA", missing };

  const P = input.P as number;
  const B = input.B ?? 0;
  const S = input.S ?? 0;
  const fee = (s.feePct / 100) * (input.freeShipping ? P : P + B);

  const profit = input.isNew
    ? round2(P - fee - S - (input.C as number) - ((input.labelMin ?? 0) * s.laborRateHr) / 60)
    : round2(P - fee - S - ((input.removalMin as number) * s.laborRateHr) / 60 - s.harvestCushion);

  const failed: Array<"sell_through" | "profit"> = [];
  const reasons: string[] = [];
  if ((input.sellThrough90 as number) < s.minSellThroughPct) {
    failed.push("sell_through");
    reasons.push(`Sell-through ${input.sellThrough90}% is below ${s.minSellThroughPct}%.`);
  }
  if (profit < s.minProfit) {
    failed.push("profit");
    reasons.push(`Profit $${profit.toFixed(2)} is below $${s.minProfit.toFixed(2)}.`);
  }
  if (failed.length) return { verdict: "REJECT", profit, failed, reasons };
  return { verdict: "GREENLIGHT", profit, reasons: [`Profit $${profit.toFixed(2)}, sell-through ${input.sellThrough90}%.`] };
}

/**
 * Lowest sold price that can greenlight a harvested part with buyer-paid shipping,
 * assuming B = 0 (unknown before research). Used only to skip research on parts
 * whose new OEM price is already below it — a used part rarely sells above new.
 */
export function minGreenlightPrice(removalMin: number, s: GreenlightSettings): number {
  const labor = (removalMin * s.laborRateHr) / 60;
  return round2((s.minProfit + s.harvestCushion + labor) / (1 - s.feePct / 100));
}

/**
 * Ranking sets ORDER only, never eligibility (D10).
 * rankScore = profit × (sold90 / 90) × share, share = min(1, sold90 / activeQty).
 */
export function rankScore(profit: number, sold90: number | null, activeQty: number | null): { score: number; share: number; flags: string[] } {
  const flags: string[] = [];
  const sold = sold90 ?? 0;
  let share = 1;
  if (activeQty != null && activeQty > 0) share = Math.min(1, sold / activeQty);
  else flags.push("no_active_count");
  return { score: round2(profit * (sold / 90) * share), share: round2(share), flags };
}
