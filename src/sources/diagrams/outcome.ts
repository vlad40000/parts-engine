import { canonicalizeMpn } from "@/src/lib/mpn";
import type { FetchResult } from "../types";
import type { DiagramAttempt, DiagramCallout, DiagramOutcome, DiagramProvider, DiagramQuery, DiagramSection, FetchOutcome, FetchRecord } from "./types";

/** A bot-check interstitial answers with a page, not the catalog ("Just a moment…", "Enable JavaScript and cookies"). */
export function isChallengePage(html: string): boolean {
  return /_cf_chl_opt|Just a moment\.\.\.|Enable JavaScript and cookies to continue|cf-challenge/i.test(html);
}

/** How a response that is not a readable page is recorded. 401/403/429 and challenges are access refusals, not absence. */
export function unreadable(res: FetchResult): { outcome: FetchOutcome; note: string } | null {
  if (res.ok && !isChallengePage(res.html)) return null;
  if (res.status === 0) return { outcome: "failed", note: `no response (${res.html || "network error"})` };
  if (res.status === 429) return { outcome: "blocked", note: "HTTP 429 rate limited" };
  if (res.status === 401 || res.status === 403 || isChallengePage(res.html)) {
    return { outcome: "blocked", note: `HTTP ${res.status}${isChallengePage(res.html) ? " bot-check challenge" : " access refused"}` };
  }
  if (res.status === 404 || res.status === 410) return { outcome: "missing", note: `HTTP ${res.status} missing page` };
  return { outcome: "failed", note: `HTTP ${res.status}` };
}

export function fetchRecord(url: string, res: FetchResult, outcome: FetchOutcome, note: string | null = null): FetchRecord {
  return { url, status: res.status, finalUrl: res.finalUrl, outcome, note };
}

export function calloutRow(
  callout: string, supplierMpn: string, description: string, supplierPartId: string | null, variantLabel: string | null = null
): DiagramCallout {
  const mpn = supplierMpn.trim();
  return {
    callout: callout.trim(), supplierMpn: mpn, mpnKey: canonicalizeMpn(mpn),
    description: description.replace(/\s+/g, " ").trim(), supplierPartId, variantLabel
  };
}

/**
 * Whole-number callouts missing between 1 and the highest listed ("6A" counts as 6). Meaningful for a maker's parts
 * key, which numbers its drawing 1..N; supplier pages may use sparse numbering (GE: 6, 7, 8, 11 … 900, 903).
 */
export function calloutGaps(callouts: Array<{ callout: string }>): string[] {
  const numbers = new Set<number>();
  for (const { callout } of callouts) {
    const m = /^(\d{1,3})[A-Z]?$/i.exec(callout);
    if (m) numbers.add(Number(m[1]));
  }
  if (!numbers.size) return [];
  const gaps: string[] = [];
  for (let n = 1; n < Math.max(...numbers); n += 1) if (!numbers.has(n)) gaps.push(String(n));
  return gaps;
}

/**
 * Keep every distinct line, including one part number at several callouts and several part numbers at one
 * callout. Only an exact repeat of the same line (same callout, MPN, retail id and sub-row) is kept once.
 */
export function keepDistinct(rows: DiagramCallout[]): { callouts: DiagramCallout[]; duplicateRows: number } {
  const seen = new Set<string>();
  const callouts: DiagramCallout[] = [];
  for (const row of rows) {
    const key = [row.callout, row.supplierMpn, row.supplierPartId ?? "", row.variantLabel ?? ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    callouts.push(row);
  }
  return { callouts, duplicateRows: rows.length - callouts.length };
}

export type AttemptDraft = {
  provider: DiagramProvider;
  query: DiagramQuery;
  retrievedAt: string;
  sourceUrl: string | null;
  identity: string;
  expectedSections: number | null;
  expectedRows?: number | null;
  sections: DiagramSection[];
  missing: string[];
  fetches: FetchRecord[];
  /** Set when nothing could be read: the attempt is blocked with this reason. */
  blocked?: string;
};

/** complete only when identity is confirmed and every published section was read; otherwise partial or blocked, with a reason. */
export function finishAttempt(d: AttemptDraft): DiagramAttempt {
  const retrievedRows = d.sections.reduce((n, s) => n + s.callouts.length, 0);
  let outcome: DiagramOutcome;
  let reason: string;
  if (d.blocked) {
    outcome = "blocked";
    reason = d.blocked;
  } else if (!d.sections.length) {
    outcome = "blocked";
    reason = d.missing.length ? `No published section could be read: ${d.missing.join("; ")}` : "The source published no sections.";
  } else if (d.missing.length || d.expectedSections === null || d.sections.length < d.expectedSections) {
    outcome = "partial";
    const of = d.expectedSections === null ? "an undeclared number of" : String(d.expectedSections);
    reason = `${d.sections.length} of ${of} published sections read.${d.missing.length ? ` Missing: ${d.missing.join("; ")}` : ""}`;
  } else {
    outcome = "complete";
    reason = `All ${d.expectedSections} published sections read for the confirmed identity.`;
  }
  return {
    provider: d.provider, brand: d.query.brand, model: d.query.model, variation: d.query.variation ?? null,
    sourceUrl: outcome === "blocked" ? null : d.sourceUrl, retrievedAt: d.retrievedAt, identity: d.identity,
    expectedSections: d.expectedSections, retrievedSections: d.sections.length,
    expectedRows: d.expectedRows ?? null, retrievedRows,
    sections: outcome === "blocked" ? [] : d.sections,
    missing: d.missing, fetches: d.fetches, outcome, reason
  };
}
