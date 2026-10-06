import { canonicalizeMpn, displayMpn } from "./mpn";
import { cellText } from "./table-read";

/**
 * Roadrunner sales history import (app-owned CSV contract):
 *
 *   mpn,source_event_id,sold_at,quantity,item_price,listed_at[,days_to_sell]
 *
 * One row = one realized sale event (order line) for one MPN.
 *   - source_event_id: stable order-line / reference ID. Re-importing the same ID is idempotent.
 *   - sold_at, listed_at: YYYY-MM-DD or M/D/YYYY.
 *   - quantity: whole units sold on that line (> 0).
 *   - item_price: price per unit, before shipping and tax. Blank = unknown.
 *   - listed_at, days_to_sell: optional. days_to_sell is derived from listed_at when not supplied.
 *
 * Allow-list import: only the columns above are read. Buyer name, username, address,
 * email, phone, payment or ZIP columns are ignored even when present.
 */
const COLUMNS = {
  mpn: "mpn",
  sourceEventId: "sourceeventid",
  soldAt: "soldat",
  quantity: "quantity",
  itemPrice: "itemprice",
  listedAt: "listedat",
  daysToSell: "daystosell"
} as const;
type Field = keyof typeof COLUMNS;
const REQUIRED: Field[] = ["mpn", "sourceEventId", "soldAt", "quantity", "itemPrice"];
export const SALES_HEADERS = "mpn,source_event_id,sold_at,quantity,item_price,listed_at";

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export type SaleRow = {
  mpnCanonical: string;
  mpnDisplay: string;
  sourceEventId: string;
  soldAt: string;
  quantity: number;
  itemPrice: number | null;
  listedAt: string | null;
  daysToSell: number | null;
  daysToSellSource: "supplied" | "derived" | null;
};

export type SaleImportResult = {
  rows: SaleRow[];
  skipped: Array<{ line: number; reason: string }>;
  missingColumns: string[];
  ignoredColumns: string[];
};

/** Calendar date as YYYY-MM-DD, or null. Accepts YYYY-MM-DD (optionally with a time) or M/D/YYYY. */
export function saleDate(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const t = cellText(v);
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) [y, m, d] = [Number(match[3]), Number(match[1]), Number(match[2])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** undefined = blank cell, null = present but unreadable. */
function number(v: unknown): number | null | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = cellText(v).replace(/[$,\s]/g, "");
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export function mapSaleRows(records: Array<Record<string, unknown>>): SaleImportResult {
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const col = new Map<Field, string>();
  for (const [field, name] of Object.entries(COLUMNS) as Array<[Field, string]>) {
    const h = headers.find((x) => normalizeHeader(x) === name);
    if (h) col.set(field, h);
  }
  const used = new Set(col.values());
  const ignoredColumns = headers.filter((h) => !used.has(h));
  const missingColumns = REQUIRED.filter((f) => !col.has(f)).map((f) => f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  if (missingColumns.length) return { rows: [], skipped: [], missingColumns, ignoredColumns };

  const get = (r: Record<string, unknown>, f: Field) => (col.has(f) ? r[col.get(f) as string] : undefined);
  const rows: SaleRow[] = [];
  const skipped: SaleImportResult["skipped"] = [];
  const seen = new Set<string>();

  records.forEach((r, i) => {
    const line = i + 2;
    const skip = (reason: string) => skipped.push({ line, reason });
    const display = displayMpn(cellText(get(r, "mpn")));
    const canonical = canonicalizeMpn(display);
    if (!canonical) return skip("no usable MPN");
    const sourceEventId = cellText(get(r, "sourceEventId"));
    if (!sourceEventId) return skip(`${display}: no source_event_id`);
    const key = `${sourceEventId}\u0000${canonical}`;
    if (seen.has(key)) return skip(`${display}: duplicate of an earlier line for event ${sourceEventId}`);

    const soldAt = saleDate(get(r, "soldAt"));
    if (!soldAt) return skip(`${display}: sold_at missing or not a date`);
    const quantity = number(get(r, "quantity"));
    if (quantity == null || !Number.isInteger(quantity) || quantity <= 0) return skip(`${display}: quantity must be a whole number above 0`);
    const price = number(get(r, "itemPrice"));
    if (price === null || (price !== undefined && price < 0)) return skip(`${display}: item_price is not a price`);

    const listedRaw = cellText(get(r, "listedAt"));
    const listedAt = listedRaw ? saleDate(listedRaw) : null;
    if (listedRaw && !listedAt) return skip(`${display}: listed_at is not a date`);
    const suppliedDays = number(get(r, "daysToSell"));
    if (suppliedDays === null || (suppliedDays !== undefined && (!Number.isInteger(suppliedDays) || suppliedDays < 0))) {
      return skip(`${display}: days_to_sell must be a whole number of 0 or more`);
    }
    let daysToSell: number | null = null;
    let daysToSellSource: SaleRow["daysToSellSource"] = null;
    if (suppliedDays !== undefined) {
      daysToSell = suppliedDays;
      daysToSellSource = "supplied";
    } else if (listedAt && listedAt <= soldAt) {
      // Listed after sold is contradictory, so nothing is derived from it.
      daysToSell = daysBetween(listedAt, soldAt);
      daysToSellSource = "derived";
    }

    seen.add(key);
    rows.push({
      mpnCanonical: canonical,
      mpnDisplay: display,
      sourceEventId,
      soldAt,
      quantity,
      itemPrice: price === undefined ? null : Math.round(price * 100) / 100,
      listedAt,
      daysToSell,
      daysToSellSource
    });
  });
  return { rows, skipped, missingColumns: [], ignoredColumns };
}
