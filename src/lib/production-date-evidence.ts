import { decodeSerial, resolveFamily, type SerialFamily } from "./serial-decoder";

export type SerialSubject = { brand: string; model: string; serial: string; asOfYear: number };
export type ProductionDateCandidate = { year: number; month: number | null; week: number | null };

export type ApplicabilityRange = {
  start?: { value: string; inclusive: boolean };
  end?: { value: string; inclusive: boolean };
};
export type ApplicabilityResult = "match" | "excluded" | "partial" | "unknown";

type SerialSequence = { series: string; number: number };
export type ProductionDateEvidence = {
  family: SerialFamily | null;
  normalizedSerial: string;
  sequence: SerialSequence | null;
  candidates: ProductionDateCandidate[];
};

function normalizeEvidenceSerial(raw: string): string {
  // Strip a nameplate label only when delimited. An embedded OCR wildcard is not a separator.
  const value = raw.trim().toUpperCase().replace(/^(?:SERIAL(?:\s+(?:NUMBER|NO\.?))?|SER|S\/N|SN)(?:\s*[:#]\s*|\s+)/, "");
  return /^[A-Z0-9]+(?:[ \t-]+[A-Z0-9]+)*$/.test(value) ? value.replace(/[ \t-]/g, "") : "";
}

function serialSequence(family: SerialFamily | null, serial: string): SerialSequence | null {
  if (family === "GE") {
    // GE support article 16195: two date letters, six digits and a final letter.
    // A documented break's numeric section is comparable within the same date code and suffix.
    const ge = /^([ADFGHLMRSTVZ]{2})(\d{6})([A-Z])$/.exec(serial);
    return ge ? { series: ge[1] + ge[3], number: Number(ge[2]) } : null;
  }
  if (family === "WHIRLPOOL") {
    // Whirlpool technical manual W11542838: site, year code, week, then five sequence digits.
    const whirlpool = /^([A-Z][A-Z0-9])((?:0[1-9]|[1-4]\d|5[0-3])\d{5})$/.exec(serial);
    return whirlpool ? { series: whirlpool[1], number: Number(whirlpool[2]) } : null;
  }
  return null;
}

/** Factory applicability requires a complete supported nameplate format. Fleet age decoding is broader. */
export function getProductionDateEvidence(input: SerialSubject): ProductionDateEvidence {
  const family = resolveFamily(input.brand, input.model);
  const normalizedSerial = normalizeEvidenceSerial(input.serial);
  const sequence = serialSequence(family, normalizedSerial);
  if (!sequence || !Number.isInteger(input.asOfYear) || input.asOfYear < 1000 || input.asOfYear > 9999) {
    return { family, normalizedSerial, sequence: null, candidates: [] };
  }
  const decoded = decodeSerial(input.brand, input.model, normalizedSerial, new Date(input.asOfYear, 6, 1));
  return {
    family,
    normalizedSerial,
    sequence: decoded.candidateYears.length ? sequence : null,
    candidates: decoded.candidateYears.map((year) => ({ year, month: decoded.month, week: decoded.week }))
  };
}

const MS_PER_DAY = 86_400_000;
type DatePeriod = ProductionDateCandidate & { day: number | null };

function utcDay(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function parseDatePeriod(value: string): DatePeriod | null {
  const parts = /^([1-9]\d{3})(?:-(?:(\d{2})(?:-(\d{2}))?|W(\d{2})))?$/.exec(value);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = parts[2] ? Number(parts[2]) : null;
  const day = parts[3] ? Number(parts[3]) : null;
  const week = parts[4] ? Number(parts[4]) : null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (week !== null && (week < 1 || week > 53)) return null;
  if (day !== null && month !== null && (day < 1 || utcDay(year, month, day) >= utcDay(year, month + 1, 1))) return null;
  return { year, month, day, week };
}

function periodBounds(period: DatePeriod, inWeeks: boolean): [number, number] {
  const { year, month, day, week } = period;
  if (inWeeks) return [year * 53 + (week ?? 1), year * 53 + (week ?? 53)];
  if (day !== null && month !== null) {
    const exact = utcDay(year, month, day);
    return [exact, exact];
  }
  if (month !== null) return [utcDay(year, month, 1), utcDay(year, month + 1, 1) - 1];
  return [utcDay(year, 1, 1), utcDay(year + 1, 1, 1) - 1];
}

/** A decoded month or week remains a period. No ISO-week conversion or exact day is inferred. */
export function evaluateProductionDateRange(
  range: ApplicabilityRange, candidates: readonly (ProductionDateCandidate | null)[]
): ApplicabilityResult[] | null {
  const start = range.start && parseDatePeriod(range.start.value);
  const end = range.end && parseDatePeriod(range.end.value);
  if (start === null || end === null) return null;
  const inWeeks = start?.week != null || end?.week != null;
  if (inWeeks && (start?.month != null || end?.month != null)) return null;
  const startBounds = start && periodBounds(start, inWeeks);
  const endBounds = end && periodBounds(end, inWeeks);
  const min = startBounds ? (range.start?.inclusive ? startBounds[0] : startBounds[1] + 1) : -Infinity;
  const max = endBounds ? (range.end?.inclusive ? endBounds[1] : endBounds[0] - 1) : Infinity;
  if (min > max) return null;

  return candidates.map((candidate) => {
    if (!candidate) return "unknown";
    const [first, last] = periodBounds({ ...candidate, day: null }, inWeeks);
    if (last < min || first > max) return "excluded";
    return first >= min && last <= max ? "match" : "partial";
  });
}
