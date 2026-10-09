import { parseCsvRows, toCsv } from "./csv";
import { RESEARCH_DATE_HEADERS } from "./market-import";
import { canonicalizeMpn } from "./mpn";
import { saleDate } from "./sales-import";

/**
 * Shared manual-research CSV: one file moves between Parts Engine and EbayDecisions
 * (its src/lib/shared-research-csv.ts) without conversion.
 *
 * The export writes exactly these headers in this order. The import matches headers ignoring
 * case, spaces and punctuation, so every spelling EbayDecisions accepts is accepted here too.
 * Parts Engine stores New Price and the 90-day window. The 7- and 30-day columns and notes are
 * accepted but not stored; columns outside the contract are ignored.
 */
export const SHARED_RESEARCH_CSV_HEADERS = [
  "mpn",
  "description",
  "notes",
  "New Price",
  "7 Day sales",
  "7 Day Avg Price",
  "30 Day sales",
  "30 Day Avg Price",
  "90 Day sales",
  "90 Day Avg Price",
  "90 Day Sell Through %"
] as const;

/** Stable, non-PII market_facts.source for this import. The uploaded filename is never stored. */
export const SHARED_RESEARCH_SOURCE = "shared_research_csv";

// EbayDecisions' bounds, so a file one app accepts the other accepts too.
export const SHARED_RESEARCH_MAX_ROWS = 5000;
/** Matches EbayDecisions shared CSV upload limit, including the edited research values. */
export const SHARED_RESEARCH_MAX_BYTES = 2 * 1024 * 1024;
/** Seven blank research cells per row; 32 UTF-8 bytes each reserves room for normal max-value entry and formatting. */
const EDITABLE_RESEARCH_HEADROOM_PER_ROW = 7 * 32;
export class SharedResearchExportError extends Error {}
const MAX_MPN_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_AMOUNT = 1_000_000;
/** market_facts.sell_through_pct is numeric(6,2); EbayDecisions itself accepts up to 100,000. */
const MAX_SELL_THROUGH_PCT = 9_999.99;

type SharedField =
  | "mpn" | "description" | "notes" | "newPrice"
  | "sold7d" | "avgPrice7d" | "sold30d" | "avgPrice30d"
  | "sold90d" | "avgPrice90d" | "sellThrough90dPct"
  | "researchedAt";

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

const FIELDS: Array<{ field: SharedField; label: string; names: string[] }> = [
  { field: "mpn", label: "mpn", names: ["mpn"] },
  { field: "description", label: "description", names: ["description"] },
  { field: "notes", label: "notes", names: ["notes"] },
  { field: "newPrice", label: "New Price", names: ["newprice"] },
  { field: "sold7d", label: "7 Day sales", names: ["7daysales"] },
  { field: "avgPrice7d", label: "7 Day Avg Price", names: ["7dayavgprice"] },
  { field: "sold30d", label: "30 Day sales", names: ["30daysales"] },
  { field: "avgPrice30d", label: "30 Day Avg Price", names: ["30dayavgprice"] },
  { field: "sold90d", label: "90 Day sales", names: ["90daysales"] },
  { field: "avgPrice90d", label: "90 Day Avg Price", names: ["90dayavgprice"] },
  { field: "sellThrough90dPct", label: "90 Day Sell Through %", names: ["90daysellthrough", "90daysellthroughpct", "90daysellthroughpercent"] },
  // Not part of the shared contract: an optional research date, under the market import's names.
  { field: "researchedAt", label: "research date", names: RESEARCH_DATE_HEADERS }
];

const BY_NAME = new Map(FIELDS.flatMap((f) => f.names.map((n) => [n, f] as const)));
const LABEL = Object.fromEntries(FIELDS.map((f) => [f.field, f.label])) as Record<SharedField, string>;
/** The lookback-window columns. Only these mark a file as the shared format ("New Price" alone does not). */
const WINDOW_FIELDS = new Set<SharedField>(["sold7d", "avgPrice7d", "sold30d", "avgPrice30d", "sold90d", "avgPrice90d", "sellThrough90dPct"]);
const NOT_STORED = new Set<SharedField>(["notes", "sold7d", "avgPrice7d", "sold30d", "avgPrice30d"]);

/** The shared research window headers found in a header row. */
export function sharedResearchHeaders(headers: string[]): string[] {
  return headers.filter((h) => {
    const entry = BY_NAME.get(normalizeHeader(h));
    return entry != null && WINDOW_FIELDS.has(entry.field);
  });
}

/** One supplied 90-day observation. Blank cells are null (unknown), never zero. */
export type SharedResearch90 = {
  sold90: number | null;
  avgPrice: number | null;
  /** Exactly as supplied, in percentage points (45 = 45%, 0.45 = 0.45%). Never derived. */
  sellThroughPct: number | null;
};

export type SharedResearchRow = {
  /** 1-based line in the file, header included. */
  line: number;
  mpnCanonical: string;
  mpnDisplay: string;
  description: string;
  newPrice: number | null;
  /** Null when the row supplies no 90-day value: such a row is not research. */
  research90: SharedResearch90 | null;
  /** From an optional research-date column; null means the import date. */
  researchedAt: string | null;
};

export type SharedResearchParse =
  | { ok: true; rows: SharedResearchRow[]; notStored: string[]; ignored: string[] }
  | { ok: false; error: string; errors: string[] };

/** Plain or comma-grouped nonnegative decimal; no sign, exponent or hex (EbayDecisions' rule). */
const DECIMAL = /^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/;

type AmountKind = "count" | "price" | "percent";

function readAmount(raw: string, kind: AmountKind, label: string, line: number): { value: number | null } | { error: string } {
  let text = raw.trim();
  if (!text) return { value: null };
  if (kind === "price") text = text.replace(/^\$\s*/, "");
  // A trailing % is a unit, not a scale: "45%" and "45" are both 45 percentage points.
  if (kind === "percent") text = text.replace(/\s*%$/, "");
  const expected = kind === "count" ? "a whole number of 0 or more" : kind === "percent" ? "a percent of 0 or more" : "a price of 0 or more";
  const value = DECIMAL.test(text) ? Number(text.replace(/,/g, "")) : Number.NaN;
  if (!Number.isFinite(value) || (kind === "count" && !Number.isInteger(value))) {
    return { error: `Line ${line}: "${label}" is "${raw.trim()}"; expected ${expected}, or leave it blank.` };
  }
  const max = kind === "percent" ? MAX_SELL_THROUGH_PCT : MAX_AMOUNT;
  // Compared as stored (to the cent), so nothing that passes can overflow its column.
  if (Math.round(value * 100) / 100 > max) {
    return { error: `Line ${line}: "${label}" is over ${max.toLocaleString("en-US")} — check for a typo.` };
  }
  return { value };
}

const fail = (error: string): SharedResearchParse => ({ ok: false, error, errors: [] });

/**
 * Parses and validates a whole shared research CSV (rows from parseCsvRows) before anything is
 * saved. Any row-level problem fails the whole file, so a corrected file can be uploaded again
 * without half of the previous attempt having been saved. Blank cells and missing columns are
 * unknown (null). Sell-through is taken only from the supplied 90 Day Sell Through % cell.
 */
export function parseSharedResearchTable(table: string[][]): SharedResearchParse {
  const [header, ...body] = table;
  if (!header || !body.length) return fail("The file needs a header row and at least one data row.");

  const positions = new Map<SharedField, number>();
  const notStored: string[] = [];
  const ignored: string[] = [];
  for (const [position, raw] of header.entries()) {
    const name = raw.trim();
    const entry = BY_NAME.get(normalizeHeader(name));
    if (!entry) {
      if (name) ignored.push(name);
      continue;
    }
    const earlier = positions.get(entry.field);
    if (earlier !== undefined) return fail(`Columns "${header[earlier].trim()}" and "${name}" are both "${entry.label}". Keep one.`);
    positions.set(entry.field, position);
    if (NOT_STORED.has(entry.field)) notStored.push(name);
  }
  if (!positions.has("mpn")) return fail(`No mpn column found. Header was: ${header.map((h) => h.trim()).join(", ")}`);
  if (body.length > SHARED_RESEARCH_MAX_ROWS) {
    return fail(`The file has ${body.length} data rows; the limit is ${SHARED_RESEARCH_MAX_ROWS}. Split it and import each part.`);
  }

  const cell = (row: string[], field: SharedField) => {
    const position = positions.get(field);
    return position === undefined ? "" : (row[position] ?? "").trim();
  };
  const rows: SharedResearchRow[] = [];
  const errors: string[] = [];
  const linesByKey = new Map<string, number[]>();

  body.forEach((row, offset) => {
    const line = offset + 2;
    const mpnDisplay = cell(row, "mpn");
    const mpnCanonical = canonicalizeMpn(mpnDisplay);
    const description = cell(row, "description");
    const problem = !mpnDisplay ? `Line ${line}: no MPN.`
      : mpnDisplay.length > MAX_MPN_LENGTH ? `Line ${line}: MPN is longer than ${MAX_MPN_LENGTH} characters.`
      : !mpnCanonical ? `Line ${line}: MPN "${mpnDisplay}" has no letters or digits.`
      : description.length > MAX_DESCRIPTION_LENGTH ? `Line ${line} (${mpnDisplay}): description is longer than ${MAX_DESCRIPTION_LENGTH} characters.`
      : null;
    if (problem) {
      errors.push(problem);
      return;
    }

    const rowErrors: string[] = [];
    const amount = (field: SharedField, kind: AmountKind) => {
      const parsed = readAmount(cell(row, field), kind, LABEL[field], line);
      if ("error" in parsed) {
        rowErrors.push(parsed.error);
        return null;
      }
      return parsed.value;
    };
    const newPrice = amount("newPrice", "price");
    const sold90 = amount("sold90d", "count");
    const avgPrice = amount("avgPrice90d", "price");
    const sellThroughPct = amount("sellThrough90dPct", "percent");
    const dateText = cell(row, "researchedAt");
    const researchedAt = dateText ? saleDate(dateText) : null;
    if (dateText && !researchedAt) rowErrors.push(`Line ${line}: research date "${dateText}" is not a date; use YYYY-MM-DD or M/D/YYYY, or leave it blank.`);
    if (rowErrors.length) {
      errors.push(...rowErrors);
      return;
    }

    linesByKey.set(mpnCanonical, [...(linesByKey.get(mpnCanonical) ?? []), line]);
    const supplied90 = sold90 != null || avgPrice != null || sellThroughPct != null;
    rows.push({
      line, mpnCanonical, mpnDisplay, description, newPrice,
      research90: supplied90 ? { sold90, avgPrice, sellThroughPct } : null,
      researchedAt
    });
  });

  for (const [key, lines] of linesByKey) {
    if (lines.length > 1) errors.push(`Lines ${lines.join(", ")}: the same MPN (key ${key}) appears more than once. Keep one row per MPN.`);
  }
  if (errors.length) {
    return { ok: false, error: `${errors.length} problem${errors.length === 1 ? "" : "s"} found; nothing was imported. Fix the file and upload it again.`, errors };
  }
  return { ok: true, rows, notStored, ignored };
}

export const parseSharedResearchCsv = (text: string) => parseSharedResearchTable(parseCsvRows(text));

export type SharedResearchExportRow = {
  mpnCanonical: string;
  mpnDisplay: string;
  description: string;
  notes: string;
  newPrice: string | number | null;
};

export type SharedResearchExport = {
  csv: string;
  /** Rows in this file: at most SHARED_RESEARCH_MAX_ROWS, in the order given. */
  exported: number;
  /** Exportable rows after this batch. A later export holds them once this batch leaves the queue. */
  later: number;
  /** D1 keys longer than the shared MPN limit. Never written and never truncated. */
  omittedMpns: string[];
  /** Rows in this file written with New Price blank: the import would reject the value. It is not changed. */
  blankNewPrices: Array<{ mpnCanonical: string; newPrice: string | number }>;
};

/**
 * Research-queue rows as one shared research CSV batch that both apps import as is. Only mpn,
 * description, notes and New Price are filled. Every research column is left blank for the operator,
 * so uploading an unedited export changes no market facts and stamps no research date.
 * Nothing outside the shared contract is written. Apart from the existing 500-character description cap, no identity or price is shortened/clamped:
 * - a row whose D1 key is longer than the MPN limit is left out (truncating could merge distinct OEM parts);
 * - a New Price the import would reject (such as one over 1,000,000) is written blank, the row kept;
 * - then the first SHARED_RESEARCH_MAX_ROWS rows are written, in the order given.
 */
/** A literal leading apostrophe prevents Excel/Sheets from interpreting supplier text as a formula.
 * For MPNs, the extra punctuation does not change the D1 key; leave it in the CSV for safe re-opening.
 */
const spreadsheetSafe = (value: string, maxLength?: number): string => {
  const unsafe = /^\s*[=+\-@]/u.test(value);
  const safe = unsafe ? "'" + value : value;
  return maxLength == null ? safe : safe.slice(0, maxLength);
};

export function buildSharedResearchExport(rows: SharedResearchExportRow[]): SharedResearchExport {
  const omittedMpns = rows.filter((r) => r.mpnCanonical.length > MAX_MPN_LENGTH).map((r) => r.mpnCanonical);
  const exportable = rows.filter((r) => r.mpnCanonical.length <= MAX_MPN_LENGTH);
  const headers = [...SHARED_RESEARCH_CSV_HEADERS];
  const headerCsv = toCsv(headers, []);
  let bytes = Buffer.byteLength(headerCsv, "utf8");
  const batch: unknown[][] = [];
  const blankNewPrices: SharedResearchExport["blankNewPrices"] = [];

  for (const r of exportable) {
    if (batch.length === SHARED_RESEARCH_MAX_ROWS) break;
    const display = r.mpnDisplay.trim();
    const chosenMpn = display.length <= MAX_MPN_LENGTH && canonicalizeMpn(display) === r.mpnCanonical
      ? display : r.mpnCanonical;
    const protectedMpn = spreadsheetSafe(chosenMpn);
    // If apostrophe protection would breach the shared 200-character limit, use the safe D1 key instead.
    const mpn = protectedMpn.length <= MAX_MPN_LENGTH ? protectedMpn : r.mpnCanonical;
    let newPrice = r.newPrice == null ? null : Number(r.newPrice).toFixed(2);
    const invalidPrice = newPrice != null && "error" in readAmount(newPrice, "price", LABEL.newPrice, 0);
    if (invalidPrice) newPrice = null;
    const record = [
      mpn,
      spreadsheetSafe(r.description.trim().slice(0, MAX_DESCRIPTION_LENGTH), MAX_DESCRIPTION_LENGTH),
      spreadsheetSafe(r.notes),
      newPrice,
      null, null, null, null, null, null, null
    ];
    // Keep queue order and reserve the bytes that filling the seven research cells will add.
    const rowCsv = toCsv(headers, [record]).slice(headerCsv.length);
    const nextBytes = bytes + Buffer.byteLength(rowCsv, "utf8");
    if (nextBytes + (batch.length + 1) * EDITABLE_RESEARCH_HEADROOM_PER_ROW > SHARED_RESEARCH_MAX_BYTES) {
      if (!batch.length) {
        throw new SharedResearchExportError(
          "The first queue row is too large for the shared 2 MiB CSV limit, including research-entry headroom. Review its notes."
        );
      }
      break;
    }
    bytes = nextBytes;
    batch.push(record);
    if (invalidPrice) blankNewPrices.push({ mpnCanonical: r.mpnCanonical, newPrice: r.newPrice! });
  }
  const csv = toCsv(headers, batch);
  if (Buffer.byteLength(csv, "utf8") !== bytes || bytes > SHARED_RESEARCH_MAX_BYTES) {
    throw new SharedResearchExportError("Research export exceeds the shared 2 MiB CSV limit.");
  }
  return { csv, exported: batch.length, later: exportable.length - batch.length, omittedMpns, blankNewPrices };
}

export const buildSharedResearchCsv = (rows: SharedResearchExportRow[]) => buildSharedResearchExport(rows).csv;
