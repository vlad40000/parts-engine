import { createHash } from "node:crypto";
import { canonicalizeMpn } from "./mpn";

export const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
export const EVIDENCE_MAX_ROWS = 5000;
export const EVIDENCE_SOURCE = "owner_research_import";
export const EVIDENCE_VERSION = 1;
export type EvidenceOptions = { blankSoldIsSkip: boolean; sellThroughUnit: "fraction" | "percent" };
export type EvidenceDecision = "researched" | "owner_skip" | "unreviewed";
export type EvidenceComparability = "unverified_aggregate" | "partial_exact_comparable" | "noncomparable" | "bundle_risk" | "unknown" | "owner_skip";
export type EvidenceMetrics = {
  sold90: number | null; avgItem: string | null; avgBuyerShipping: string | null;
  sellThrough: { value: string; unit: "fraction" | "percent"; percent: string } | null;
};
export type EvidenceRow = {
  sourceRow: number; mpnDisplay: string; inputMpnKey: string; description: string;
  decision: EvidenceDecision; comparability: EvidenceComparability;
  raw: Record<string, string | number | null>;
  metrics: EvidenceMetrics; audited: EvidenceMetrics;
  observedOn: string | null; windowStart: string | null; windowEnd: string | null;
  auditedOn: string | null; auditedWindowStart: string | null; auditedWindowEnd: string | null;
  incorporatedOn: string | null; notes: string;
};
export type EvidenceFile = {
  sourceSha256: string; format: "owner_workbook" | "master_workbook" | "evidence_table";
  sheet: string | null; options: EvidenceOptions; rows: EvidenceRow[]; warnings: string[];
};
export class ResearchEvidenceError extends Error {}
export const evidenceHash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const FIELDS = {
  mpn: ["mpn"], description: ["description"],
  sold: ["sold90", "90daysold", "90daysales", "90debayunitssold"],
  price: ["avgitem", "avgprice", "90daysoldavgprice", "90dayavgprice", "90debayaveragesoldprice"],
  shipping: ["avgbuyershipping", "avgship", "90dayavgshipping", "owner90davgshipping"],
  sellThrough: ["sellthrough", "sellthroughpct", "90daysellthrough", "90daysellthroughpct", "90debaysellthrough"],
  unit: ["sellthroughunit"], decision: ["ownerdecision"], comparability: ["salescomparability", "comparability"],
  auditedSold: ["auditedsold90", "comparableusedunitsaudited"],
  auditedPrice: ["auditedavgitem", "comparableusedavgitem"],
  auditedShipping: ["auditedavgbuyershipping", "comparableavgbuyershipping"],
  auditedSellThrough: ["auditedsellthrough"], auditedUnit: ["auditedsellthroughunit"],
  observedOn: ["observedon", "researchdate", "researchedat"],
  incorporatedOn: ["incorporatedon", "ebayresearchdate"],
  windowStart: ["windowstart"], windowEnd: ["windowend"], auditedOn: ["auditedon"],
  auditedWindowStart: ["auditedwindowstart"], auditedWindowEnd: ["auditedwindowend"],
  notes: ["notes", "researchevidencenotes"]
} satisfies Record<string, string[]>;
type Field = keyof typeof FIELDS;
export const evidenceHeader = (cells: string[]) => cells.some((c) => key(c) === "mpn");
const isBlank = (v: unknown) => v == null || String(v).trim() === "";

function safeText(value: unknown, label: string, max: number): string {
  const text = value == null ? "" : String(value).trim();
  if (text.length > max) throw new ResearchEvidenceError(`${label} is too long (maximum ${max} characters).`);
  if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)
    || /(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/.test(text)
    || /\b\d{1,6}\s+[a-z ]+\s(?:street|avenue|road|lane)\b/i.test(text)) {
    throw new ResearchEvidenceError(`${label} contains possible personal contact information. Remove it before importing.`);
  }
  return text;
}
function plainNumber(n: number): string {
  const s = String(n);
  if (!/[eE]/.test(s)) return s;
  const [mantissa, exponent] = s.toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = whole + fraction, point = whole.length + Number(exponent);
  return point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
}
type NumberKind = "quantity" | "money" | "ratio";
const NUMBER_SYNTAX: Record<NumberKind, string> = {
  quantity: "must be a plain nonnegative number without $ or %, or blank",
  money: "must be a nonnegative decimal, optionally with a leading $, or blank",
  ratio: "must be a nonnegative decimal, optionally with a trailing %, or blank"
};
/** Field-specific syntax: only prices/shipping may carry a leading $, only sell-through a
 * trailing %. The limit and whole-number checks use the exact decimal text, never a rounded Number. */
function decimal(value: unknown, label: string, kind: NumberKind): string | null {
  if (isBlank(value)) return null;
  let text = typeof value === "number" ? plainNumber(value) : String(value).trim();
  if (kind === "money") text = text.replace(/^\$\s*/, "");
  if (kind === "ratio") text = text.replace(/\s*%$/, "");
  if (text.length > 45 || !/^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/.test(text)) {
    throw new ResearchEvidenceError(`${label} ${NUMBER_SYNTAX[kind]}.`);
  }
  const cleaned = text.replace(/,/g, "");
  const [whole, fraction = ""] = cleaned.split(".");
  const integer = whole.replace(/^0+/, ""), significantFraction = fraction.replace(/0+$/, "");
  if (integer.length > 7 || (integer.length === 7 && (integer !== "1000000" || significantFraction))) {
    throw new ResearchEvidenceError(`${label} is over 1,000,000.`);
  }
  if (kind === "quantity" && significantFraction) throw new ResearchEvidenceError(`${label} must be a whole number.`);
  return cleaned.startsWith(".") ? `0${cleaned}` : cleaned;
}
function times100(s: string): string {
  const [whole, fraction = ""] = s.split(".");
  const padded = fraction.padEnd(2, "0");
  const left = (whole + padded.slice(0, 2)).replace(/^0+(?=\d)/, "");
  return padded.length > 2 ? `${left}.${padded.slice(2)}` : left;
}
function date(value: unknown, label: string): string | null {
  if (isBlank(value)) return null;
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s.startsWith("0000") || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new ResearchEvidenceError(`${label} must be a valid YYYY-MM-DD date, or blank.`);
  }
  return s;
}

/** Pure validation. Raw supplied values and blank/zero distinctions survive unchanged. */
export function parseEvidenceTable(records: Record<string, unknown>[], metadata: Omit<EvidenceFile, "rows" | "warnings">): EvidenceFile {
  if(!/^[a-f0-9]{64}$/.test(metadata.sourceSha256))throw new ResearchEvidenceError("Invalid source fingerprint.");
  if(metadata.sheet!=null)safeText(metadata.sheet,"Sheet name",100);
  if (!records.length || records.length > EVIDENCE_MAX_ROWS) throw new ResearchEvidenceError(`Supply 1–${EVIDENCE_MAX_ROWS} MPN rows.`);
  const headers = [...new Set(records.flatMap((r)=>Object.keys(r)))];
  if(new Set(headers.map(key)).size!==headers.length)throw new ResearchEvidenceError("The file has duplicate headers. Keep one of each.");
  const columns = new Map<Field, string>();
  for (const [field, aliases] of Object.entries(FIELDS) as [Field, string[]][]) {
    const matches = headers.filter((h) => aliases.includes(key(h)));
    if (matches.length > 1) throw new ResearchEvidenceError(`More than one ${field} column. Keep one.`);
    if (matches[0]) columns.set(field, matches[0]);
  }
  if (!columns.has("mpn") || !columns.has("sold")) throw new ResearchEvidenceError("The file needs MPN and a supported 90-day sold column.");
  const seen = new Set<string>();
  const rows: EvidenceRow[] = records.map((record, i) => {
    const sourceRow = typeof record.__sourceRow === "number" ? record.__sourceRow : i + 2;
    const at = `Row ${sourceRow}`;
    const get = (f: Field) => columns.has(f) ? record[columns.get(f)!] : null;
    const mpnDisplay = safeText(get("mpn"), `${at} MPN`, 200), inputMpnKey = canonicalizeMpn(mpnDisplay);
    if (!inputMpnKey || inputMpnKey.length > 200) throw new ResearchEvidenceError(`${at} needs an exact MPN.`);
    if (seen.has(inputMpnKey)) throw new ResearchEvidenceError(`${at} duplicates an MPN. Keep one row per exact identity.`);
    seen.add(inputMpnKey);
    const metrics = (audited: boolean): EvidenceMetrics => {
      const scope = audited ? `${at} audited` : at;
      // decimal() has already proved a whole number within 1,000,000, so Number() is exact.
      const sold = decimal(get(audited ? "auditedSold" : "sold"), `${scope} sold quantity`, "quantity");
      const v = get(audited ? "auditedSellThrough" : "sellThrough");
      const value = decimal(v, `${scope} sell-through`, "ratio");
      const unitInput = get(audited ? "auditedUnit" : "unit");
      const unit = typeof v === "string" && v.trim().endsWith("%") ? "percent"
        : isBlank(unitInput) ? metadata.options.sellThroughUnit : String(unitInput).trim().toLowerCase();
      if (unit !== "fraction" && unit !== "percent") throw new ResearchEvidenceError(`${at} sell-through unit must be fraction or percent.`);
      return {
        sold90: sold == null ? null : Number(sold),
        avgItem: decimal(get(audited ? "auditedPrice" : "price"), `${scope} item price`, "money"),
        avgBuyerShipping: decimal(get(audited ? "auditedShipping" : "shipping"), `${scope} buyer shipping`, "money"),
        sellThrough: value == null ? null : {value, unit, percent: unit === "fraction" ? times100(value) : value}
      };
    };
    const rawMetrics = metrics(false), audited = metrics(true);
    const suppliedDecision = key(String(get("decision") ?? ""));
    const hasSummary = Object.values(rawMetrics).some((v) => v != null);
    const decision: EvidenceDecision = suppliedDecision === "ownerskip" ? "owner_skip"
      : suppliedDecision === "researched" ? "researched" : suppliedDecision === "unreviewed" ? "unreviewed"
        : metadata.options.blankSoldIsSkip && rawMetrics.sold90 == null ? "owner_skip" : hasSummary ? "researched" : "unreviewed";
    if (suppliedDecision && !["ownerskip", "researched", "unreviewed"].includes(suppliedDecision)) throw new ResearchEvidenceError(`${at} has an unsupported owner decision.`);
    if (decision === "owner_skip" && (rawMetrics.sold90 != null || Object.values(audited).some((v) => v != null))) throw new ResearchEvidenceError(`${at} Owner Skip conflicts with supplied sold or audited evidence.`);
    if (decision === "researched" && !hasSummary) throw new ResearchEvidenceError(`${at} is marked researched but has no summary values.`);
    const comparabilityKey = key(String(get("comparability") ?? ""));
    const kinds: Record<string, EvidenceComparability> = {
      unverifiedaggregate: "unverified_aggregate", partialexactcomparable: "partial_exact_comparable",
      noncomparable: "noncomparable", bundlerisk: "bundle_risk", unknown: "unknown", ownerskip: "owner_skip"
    };
    if (comparabilityKey && !Object.hasOwn(kinds, comparabilityKey)) throw new ResearchEvidenceError(`${at} has an unsupported comparability label.`);
    const comparability = decision === "owner_skip" ? "owner_skip" : kinds[comparabilityKey] ?? (hasSummary ? "unverified_aggregate" : "unknown");
    if (comparability === "owner_skip" && decision !== "owner_skip") throw new ResearchEvidenceError(`${at} comparability conflicts with its owner decision.`);
    const observedOn = date(get("observedOn"), `${at} observation date`);
    const windowStart = date(get("windowStart"), `${at} window start`), windowEnd = date(get("windowEnd"), `${at} window end`);
    const auditedWindowStart = date(get("auditedWindowStart"), `${at} audited window start`), auditedWindowEnd = date(get("auditedWindowEnd"), `${at} audited window end`);
    if ((windowStart && windowEnd && windowStart > windowEnd) || (auditedWindowStart && auditedWindowEnd && auditedWindowStart > auditedWindowEnd)) throw new ResearchEvidenceError(`${at} has a reversed measurement window.`);
    const raw: EvidenceRow["raw"] = {};
    for (const [field] of columns) {
      const v = get(field);
      raw[field] = v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : typeof v === "number" ? v : safeText(v, `${at} ${field}`, field === "notes" ? 2000 : 500);
    }
    return {
      sourceRow, mpnDisplay, inputMpnKey, description: safeText(get("description"), `${at} description`, 500),
      decision, comparability, raw, metrics: rawMetrics, audited, observedOn, windowStart, windowEnd,
      auditedOn: date(get("auditedOn"), `${at} audit date`), auditedWindowStart, auditedWindowEnd,
      incorporatedOn: date(get("incorporatedOn"), `${at} incorporation date`), notes: safeText(get("notes"), `${at} notes`, 2000)
    };
  });
  const warnings = [
    "Saving evidence does not update active market facts, qualification, rankings or inventory.",
    "Only supported evidence columns are retained; other sheets and planning calculations are not imported."
  ];
  if (rows.some((r) => !r.observedOn)) warnings.push("Some original observation dates are unknown; import time and master incorporation dates are kept separate.");
  if (rows.some((r) => !r.windowStart || !r.windowEnd)) warnings.push("Some search windows are unknown. Raw summaries and audited subsets may cover different periods.");
  return {...metadata, rows, warnings};
}
