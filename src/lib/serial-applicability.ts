import {
  evaluateProductionDateRange, getProductionDateEvidence,
  type ApplicabilityRange, type ApplicabilityResult, type ProductionDateEvidence, type SerialSubject
} from "./production-date-evidence";

type ApplicabilityRule =
  | { kind: "serial" | "build_date"; range: ApplicabilityRange }
  | { kind: "revision"; code: string };

const SERIAL_LABEL = "(?:serials?(?:\\s+(?:numbers?|no\\.?|range))?|s/n|sn)(?:\\s*[:#]\\s*|\\s+)";
const SERIAL_VALUE = `(?:${SERIAL_LABEL})?([A-Z0-9]+)`;
const DATE_VALUE = "([1-9]\\d{3}(?:-(?:W\\d{2}|\\d{2}(?:-\\d{2})?))?)";

function parseRange(note: string, endpoint: string): ApplicabilityRange | null {
  const bracketed = new RegExp(`^(\\[|\\()\\s*${endpoint}\\s*,\\s*${endpoint}\\s*(\\]|\\))$`, "i").exec(note);
  if (bracketed) {
    return {
      start: { value: bracketed[2].toUpperCase(), inclusive: bracketed[1] === "[" },
      end: { value: bracketed[3].toUpperCase(), inclusive: bracketed[4] === "]" }
    };
  }
  const closed = new RegExp(`^(?:from\\s+)?${endpoint}(?:\\s+(?:to|through)\\s+|\\s*[-–—]\\s*)${endpoint}$`, "i").exec(note)
    ?? new RegExp(`^between\\s+${endpoint}\\s+and\\s+${endpoint}$`, "i").exec(note);
  if (closed) {
    return {
      start: { value: closed[1].toUpperCase(), inclusive: true },
      end: { value: closed[2].toUpperCase(), inclusive: true }
    };
  }
  const upper = new RegExp(`^(before|prior to|through|up to and including)\\s+${endpoint}$`, "i").exec(note);
  if (upper) return { end: { value: upper[2].toUpperCase(), inclusive: /^(through|up to)/i.test(upper[1]) } };
  const lower = new RegExp(`^(after|from|starting (?:with|at)|beginning with|since)\\s+${endpoint}$`, "i").exec(note);
  if (lower) return { start: { value: lower[2].toUpperCase(), inclusive: lower[1].toLowerCase() !== "after" } };
  return null;
}

/** Parse a complete applicability note. A match inside a longer, unsupported condition is insufficient. */
export function parseApplicabilityNote(raw: string): ApplicabilityRule | null {
  const note = raw.trim().replace(/\.$/, "").replace(/\s+/g, " ");
  const revision = /^(?:model )?(?:revision|rev\.?)(?: *[:=] *| )([./-]?[A-Z0-9]+(?:[./-][A-Z0-9]+)*)$/i.exec(note);
  if (revision) return { kind: "revision", code: revision[1].toUpperCase() };

  const date = /^(?:manufactured|made|built|(?:production|build) date(?: range)?)(?: *: *| )(.+)$/i.exec(note);
  if (date) {
    const range = parseRange(date[1], DATE_VALUE);
    return range ? { kind: "build_date", range } : null;
  }

  const serial = note.replace(new RegExp(`^${SERIAL_LABEL}`, "i"), "");
  const range = parseRange(serial, SERIAL_VALUE);
  return range ? { kind: "serial", range } : null;
}

type ApplicabilitySubject = SerialSubject & { revision?: string | null };

function checkSerialRange(
  range: ApplicabilityRange, input: SerialSubject, production: ProductionDateEvidence
): ApplicabilityResult | null {
  if (production.family !== "GE" && production.family !== "WHIRLPOOL") return "unknown";
  const start = range.start && getProductionDateEvidence({ ...input, serial: range.start.value }).sequence;
  const end = range.end && getProductionDateEvidence({ ...input, serial: range.end.value }).sequence;
  if (start === null || end === null || (start && end && start.series !== end.series)) return null;
  const min = start ? start.number + (range.start?.inclusive ? 0 : 1) : -Infinity;
  const max = end ? end.number - (range.end?.inclusive ? 0 : 1) : Infinity;
  if (min > max) return null;

  const { sequence } = production;
  if (!sequence || sequence.series !== (start ?? end)?.series) return "unknown";
  return sequence.number >= min && sequence.number <= max ? "match" : "excluded";
}

// An excluded condition is decisive. Missing information cannot turn a partial match into proof.
const RESULT_ORDER: Record<ApplicabilityResult, number> = { excluded: 0, unknown: 1, partial: 2, match: 3 };

/** One result per plausible production date, or one unknown-date result when the serial gives none. */
export function evaluateSerialApplicability(
  notes: readonly string[], input: ApplicabilitySubject, production = getProductionDateEvidence(input)
): ApplicabilityResult[] | null {
  if (!notes.length) return null;
  const dates = production.candidates.length ? production.candidates : [null];
  let results = dates.map((): ApplicabilityResult => "match");
  for (const note of notes) {
    const rule = parseApplicabilityNote(note);
    if (!rule) return null;
    if (rule.kind === "build_date") {
      const check = evaluateProductionDateRange(rule.range, dates);
      if (!check) return null;
      results = results.map((prior, i) => RESULT_ORDER[prior] <= RESULT_ORDER[check[i]] ? prior : check[i]);
      continue;
    }
    let check: ApplicabilityResult | null;
    if (rule.kind === "revision") {
      const actual = input.revision?.trim().toUpperCase();
      check = !actual ? "unknown" : actual === rule.code ? "match" : "excluded";
    } else {
      check = checkSerialRange(rule.range, input, production);
    }
    if (check === null) return null;
    results = results.map((prior) => RESULT_ORDER[prior] <= RESULT_ORDER[check] ? prior : check);
  }
  return results;
}
