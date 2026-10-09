import { canonicalizeMpn } from "./mpn";

/**
 * Market facts import (research import). Accepts:
 *   - EbayDecisions /api/parts/export CSV (90d_* columns, active_listing_qty)
 *   - Roadrunner_eBay_Decision_Workbook.xlsx "MPN Master" sheet
 *   - a plain CSV: mpn, sold90, avg_price, avg_ship, sell_through_pct, active_qty, researched_at
 * The shared research CSV (7/30/90 Day columns) is read by shared-research-csv.ts instead.
 */
const COLUMNS: Record<string, string[]> = {
  mpn: ["mpn", "partnumber", "part", "sku"],
  description: ["description", "desc", "partdescription"],
  sold90: ["90dsoldqty", "sold90", "mktsold90d", "sold90d", "soldqty90d"],
  avgPrice: ["90dprice", "avgprice", "mktprice", "price90d", "averageprice"],
  avgShip: ["90dshipping", "avgship", "mktship", "shipping90d", "averageshipping"],
  sellThrough: ["sellthroughpct", "mkt90dsellthrough", "sellthrough", "str", "90dsellthrough"],
  activeQty: ["activelistingqty", "activeqty", "mktactivelistingsderived", "mktactivelistings", "activelistings"],
  qtyOnHand: ["qtyonhand", "inventoryqty", "onhand"],
  researchedAt: ["researchedat", "90dcapturedat", "researchdate", "date"],
  freeShipping: ["freeshipping"],
  shipCost: ["shipcost", "myshipping"]
};

/** Stable, non-PII source label for file imports. The uploaded filename is never stored. */
export const MARKET_IMPORT_SOURCE = "market_import";

/** Normalized names of a research-date column. */
export const RESEARCH_DATE_HEADERS = COLUMNS.researchedAt;

export type SellThroughSource = "manual" | "research";

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Headers this import reads as market facts (sold, price, shipping, sell-through, active). */
export function legacyResearchHeaders(headers: string[]): string[] {
  const names = new Set(["sold90", "avgPrice", "avgShip", "sellThrough", "activeQty"].flatMap((f) => COLUMNS[f]));
  return headers.filter((h) => names.has(normalizeHeader(h)));
}

export type MarketRow = {
  mpnCanonical: string;
  mpnDisplay: string;
  description: string | null;
  sold90: number | null;
  avgPrice: number | null;
  avgShip: number | null;
  /** Exact-MPN 90-day sell-through %, only when the source supplied it. Never derived. */
  sellThroughPct: number | null;
  sellThroughSource: SellThroughSource | null;
  activeQty: number | null;
  qtyOnHand: number | null;
  researchedAt: string | null;
  freeShipping: boolean;
  shipCost: number | null;
};

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && v && "result" in v) return num((v as { result: unknown }).result);
  const t = String(v).replace(/[$,%\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function dateText(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = v == null ? "" : String(v).trim();
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Sell-through is stored as a percent. In these legacy formats a value ≤ 1 is read as a fraction
 * (the decision workbook stores 0.24 for 24%). The shared research CSV never does this.
 */
export function percent(v: number | null): number | null {
  if (v == null) return null;
  return v <= 1 ? Math.round(v * 10000) / 100 : Math.round(v * 100) / 100;
}

export function mapMarketRows(records: Array<Record<string, unknown>>): { rows: MarketRow[]; skipped: string[] } {
  if (!records.length) return { rows: [], skipped: ["No rows."] };
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const col = new Map<string, string>();
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    for (const a of aliases) {
      const h = headers.find((x) => normalizeHeader(x) === a);
      if (h) { col.set(field, h); break; }
    }
  }
  if (!col.has("mpn")) return { rows: [], skipped: [`No MPN column. Headers: ${headers.join(", ")}`] };
  const get = (r: Record<string, unknown>, f: string) => (col.has(f) ? r[col.get(f) as string] : undefined);

  const rows: MarketRow[] = [];
  const skipped: string[] = [];
  records.forEach((r, i) => {
    const display = String(get(r, "mpn") ?? "").trim();
    const canonical = canonicalizeMpn(display);
    if (!canonical) return;
    const sold90 = num(get(r, "sold90"));
    const activeQty = num(get(r, "activeQty"));
    // Exact sell-through only as supplied; sold90 and activeQty stay separate facts.
    const sellThroughPct = percent(num(get(r, "sellThrough")));
    if (sold90 == null && num(get(r, "avgPrice")) == null) {
      skipped.push(`Line ${i + 2} (${display}): no 90-day sold count or price.`);
      return;
    }
    const free = String(get(r, "freeShipping") ?? "").trim().toLowerCase();
    rows.push({
      mpnCanonical: canonical,
      mpnDisplay: display,
      description: String(get(r, "description") ?? "").trim() || null,
      sold90: sold90 == null ? null : Math.round(sold90),
      avgPrice: num(get(r, "avgPrice")),
      avgShip: num(get(r, "avgShip")),
      sellThroughPct,
      sellThroughSource: sellThroughPct == null ? null : "research",
      activeQty: activeQty == null ? null : Math.round(activeQty),
      qtyOnHand: num(get(r, "qtyOnHand")),
      researchedAt: dateText(get(r, "researchedAt")),
      freeShipping: free === "true" || free === "yes" || free === "1",
      shipCost: num(get(r, "shipCost"))
    });
  });
  return { rows, skipped };
}
