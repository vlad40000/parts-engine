import { brandKey, isUnreadableModel } from "./model-key";
import { canonicalizeMpn, displayMpn } from "./mpn";
import type { MarkingClaim, OemEvidence, OemSource, OriginalMpnEvidence, PartScope } from "./oem-evidence";
import { getProductionDateEvidence, type ApplicabilityResult, type SerialSubject } from "./production-date-evidence";
import { evaluateSerialApplicability } from "./serial-applicability";

export type OriginalMpnInput = PartScope & SerialSubject & {
  machineNo: string | null;
  revision?: string | null;
  observedMarking?: string | null;
};

type EvaluatedOriginal = {
  claim: OriginalMpnEvidence;
  mpnCanonical: string;
  checks: ApplicabilityResult[] | null;
  reviewedOemRule: boolean;
};
type PredictionDecision =
  | { status: "serial_supported"; resolvedMpnCanonical: string }
  | { status: "unresolved" | "candidate" | "conflict"; resolvedMpnCanonical: null };

const SOURCE_ORDER: Record<OemSource["kind"], number> = {
  oem_serial_document: 0, oem_historical_bom: 1, oem_model_diagram: 2,
  specialist_distributor: 3, reseller: 4, archive_capture: 5
};

const exact = (value: string) => value.trim().toUpperCase();
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function compareEvidence(a: OemEvidence, b: OemEvidence): number {
  return SOURCE_ORDER[a.source.kind] - SOURCE_ORDER[b.source.kind]
    || compareText(a.source.id, b.source.id)
    || compareText(JSON.stringify(a), JSON.stringify(b));
}

function matchesScope(wanted: PartScope, scope: PartScope): boolean {
  const model = exact(wanted.model);
  return Boolean(brandKey(wanted.brand) && exact(wanted.component) && /[A-Z0-9]/.test(model) && !isUnreadableModel(model))
    && brandKey(wanted.brand) === brandKey(scope.brand)
    && model === exact(scope.model)
    && exact(wanted.component) === exact(scope.component);
}

function hasPossibleMatch(checks: ApplicabilityResult[]): boolean {
  return checks.some((result) => result === "match" || result === "partial");
}

function decideOriginals(claims: EvaluatedOriginal[], dateCount: number): PredictionDecision {
  const supported = claims.filter(({ reviewedOemRule, checks }) => reviewedOemRule && checks && hasPossibleMatch(checks));
  if (supported.length) {
    // A catalog-only row does not assert which serial it covers. Duplicates never add weight.
    const competingKeys = new Set(claims.filter(({ reviewedOemRule, checks }) => checks && (
      reviewedOemRule ? checks.some((result) => result !== "excluded") : hasPossibleMatch(checks)
    )).map(({ mpnCanonical }) => mpnCanonical));
    const covered = Array.from({ length: dateCount }, (_, i) =>
      supported.some(({ checks }) => checks?.[i] === "match")
    ).every(Boolean);
    return competingKeys.size === 1 && covered
      ? { status: "serial_supported", resolvedMpnCanonical: supported[0].mpnCanonical }
      : { status: "conflict", resolvedMpnCanonical: null };
  }
  const candidateKeys = new Set(claims.filter(({ checks }) => !checks || hasPossibleMatch(checks))
    .map(({ mpnCanonical }) => mpnCanonical));
  const status = candidateKeys.size > 1 ? "conflict" : candidateKeys.size === 1 ? "candidate" : "unresolved";
  return { status, resolvedMpnCanonical: null };
}

/** Resolve supplied evidence anew for one donor and slot. No BOM, alias, listing or persistence dependency. */
export function resolveOriginalMpn(input: OriginalMpnInput, evidence: readonly OemEvidence[]) {
  const productionDate = getProductionDateEvidence(input);
  const sources = evidence.filter(({ source }) => source.kind !== "archive_capture" && source.id.trim() && source.url.trim());
  const originals: EvaluatedOriginal[] = [];
  for (const claim of sources) {
    if (claim.kind !== "original" || !matchesScope(input, claim.scope)) continue;
    const mpnCanonical = canonicalizeMpn(claim.mpn);
    if (!mpnCanonical) continue;
    const checks = claim.applicability ? evaluateSerialApplicability(claim.applicability.notes, input, productionDate) : null;
    if (claim.applicability && (!checks || checks.every((result) => result === "excluded"))) continue;
    const reviewedOemRule = claim.applicability?.validated === true
      && (claim.source.kind === "oem_serial_document" || claim.source.kind === "oem_historical_bom");
    originals.push({ claim, mpnCanonical, checks, reviewedOemRule });
  }

  const byMpn = new Map<string, EvaluatedOriginal[]>();
  for (const row of originals.sort((a, b) => compareEvidence(a.claim, b.claim))) {
    const group = byMpn.get(row.mpnCanonical) ?? [];
    group.push(row);
    byMpn.set(row.mpnCanonical, group);
  }
  const candidates = [...byMpn.keys()].sort(compareText).map((mpnCanonical) => {
    const claims = byMpn.get(mpnCanonical)!;
    return { mpnCanonical, mpnDisplay: displayMpn(claims[0].claim.mpn), claims };
  });
  const decision = decideOriginals(originals, Math.max(1, productionDate.candidates.length));

  const brand = brandKey(input.brand);
  const observedMarking = input.observedMarking?.trim() || null;
  const markingClaims = sources.filter((claim): claim is MarkingClaim => claim.kind === "marking_claim" && observedMarking !== null
    && brand !== "" && brandKey(claim.brand) === brand
    && exact(claim.marking) === exact(observedMarking) && Boolean(canonicalizeMpn(claim.mpn)))
    .sort((a, b) => compareText(canonicalizeMpn(a.mpn), canonicalizeMpn(b.mpn)) || compareEvidence(a, b));
  const markingKeys = new Set(markingClaims.map((claim) => canonicalizeMpn(claim.mpn)));
  const markingStatus: "conflict" | "claimed" | "unresolved" = markingKeys.size > 1 ? "conflict"
    : markingKeys.size === 1 ? "claimed" : "unresolved";

  const replacementOrigins = new Set([...byMpn.keys(), ...markingKeys]);
  const serviceReplacements = sources.flatMap((claim) => {
    if (claim.kind !== "replacement") return [];
    const fromMpnCanonical = canonicalizeMpn(claim.fromMpn);
    const toMpnCanonical = canonicalizeMpn(claim.toMpn);
    if (!fromMpnCanonical || !toMpnCanonical || fromMpnCanonical === toMpnCanonical) return [];
    return [{ ...claim, fromMpnCanonical, toMpnCanonical }];
  });
  const scopedEdges = serviceReplacements.filter(({ scope }) => scope.model !== undefined && matchesScope(input, scope));
  for (const edge of scopedEdges) replacementOrigins.add(edge.fromMpnCanonical);
  const crossReferences = serviceReplacements.filter(({ scope, fromMpnCanonical }) => scope.model === undefined
    && brand !== "" && brandKey(scope.brand) === brand && replacementOrigins.has(fromMpnCanonical));

  return {
    machineNo: input.machineNo,
    productionDate,
    factoryOriginalPrediction: { ...decision, candidates },
    serviceReplacements: [...scopedEdges, ...crossReferences].sort((a, b) =>
      compareText(a.fromMpnCanonical, b.fromMpnCanonical) || compareText(a.toMpnCanonical, b.toMpnCanonical) || compareEvidence(a, b)
    ),
    markingEvidence: observedMarking ? {
      observedMarking, status: markingStatus, claims: markingClaims
    } : null
  };
}
