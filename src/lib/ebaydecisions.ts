import "server-only";
import { z } from "zod";
import type { ProviderActivePatch, ProviderSoldPatch } from "@/src/db/queries";
import { canonicalizeMpn } from "./mpn";

/**
 * EbayDecisions integration client (Integrations A2 + A4).
 *
 * Explicit, user-triggered POSTs to EbayDecisions' merged provider routes (schemaVersion 1):
 * `/api/integrations/market-facts` (A2, zero-write stored facts, behind "Refresh market facts"), and the
 * A3 provider's `/api/integrations/parts/register` and `/api/integrations/research`. The last two are
 * dormant: no page or action calls them until official eBay API research is activated; the shared
 * research CSV is the research path meanwhile.
 * Service-to-service over HTTPS with `Authorization: Bearer EBAYDECISIONS_API_KEY`; this module never
 * opens EbayDecisions' database and never logs or returns the key. Any response that does not match
 * v1 exactly is rejected before anything is written.
 */
export const EBAYDECISIONS_ROUTE = "/api/integrations/market-facts";
export const EBAYDECISIONS_REGISTER_ROUTE = "/api/integrations/parts/register";
export const EBAYDECISIONS_RESEARCH_ROUTE = "/api/integrations/research";
export const EBAYDECISIONS_SCHEMA_VERSION = 1;
export const EBAYDECISIONS_MAX_MPNS = 100;
export const EBAYDECISIONS_TIMEOUT_MS = 15_000;
/** The provider's per-call registration and research cap. */
export const EBAYDECISIONS_RESEARCH_MAX_MPNS = 20;
/**
 * Research runs a Browse and an Insights call per MPN, spaced out by the provider. Register (15 s) +
 * research (240 s) + market facts (15 s) needs a function budget of 300 s once research is activated.
 */
export const EBAYDECISIONS_RESEARCH_TIMEOUT_MS = 240_000;
/** market_facts.source for facts cached from the live provider. */
export const EBAYDECISIONS_SOURCE = "ebaydecisions_api";

// Field bounds of the provider's strict request schemas; a longer value would reject the whole batch.
const PROVIDER_MPN_MAX = 200;
const PROVIDER_DESCRIPTION_MAX = 500;

export type EbayDecisionsConfig = { url: string; apiKey: string };

/** Null when either setting is absent: the app stays usable and CSV import remains the path. */
export function ebayDecisionsConfig(env: Record<string, string | undefined> = process.env): EbayDecisionsConfig | null {
  const url = env.EBAYDECISIONS_URL?.trim();
  const apiKey = env.EBAYDECISIONS_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), apiKey };
}

export const isEbayDecisionsConfigured = () => ebayDecisionsConfig() != null;

/** Thrown for every failed request or rejected response. Messages never include the API key. */
export class EbayDecisionsError extends Error {}

// Bounds match the Parts Engine columns the facts are cached in, so a valid response can always be written.
const money = z.number().finite().nonnegative().max(99_999_999.99).nullable();
const count = z.number().int().nonnegative().max(2_147_483_647).nullable();
const timestamp = z.string().datetime({ offset: true });

const sold90Schema = z.object({
  soldQty: count,
  avgSoldPrice: money,
  avgBuyerShipping: money,
  sellThroughPct: z.number().finite().nonnegative().max(9_999.99).nullable(),
  source: z.enum(["manual", "ebay_insights", "ebay_browse"]),
  priceBasis: z.enum(["unknown", "sold", "asking"]),
  capturedAt: timestamp
});

const activeSchema = z.object({
  activeQty: count,
  askingPrice: money,
  askingShipping: money,
  source: z.enum(["manual", "ebay_browse"]),
  sampleSize: count,
  truncated: z.boolean(),
  capturedAt: timestamp
});

const factSchema = z.discriminatedUnion("status", [
  z.object({
    mpnKey: z.string().min(1),
    mpnDisplay: z.string().nullable(),
    status: z.literal("found"),
    sold90: sold90Schema.nullable(),
    active: activeSchema.nullable()
  }),
  z.object({
    mpnKey: z.string().min(1),
    mpnDisplay: z.null(),
    status: z.literal("unregistered"),
    sold90: z.null(),
    active: z.null()
  })
]);

const envelopeSchema = z.object({
  schemaVersion: z.literal(EBAYDECISIONS_SCHEMA_VERSION),
  generatedAt: timestamp,
  facts: z.array(factSchema).max(EBAYDECISIONS_MAX_MPNS)
});

export type ProviderFact = z.infer<typeof factSchema>;

/** D1 keys for a batch: canonicalized, de-duplicated (first seen kept), blanks dropped. */
export function batchKeys(mpns: Iterable<string>): string[] {
  return [...new Set([...mpns].map(canonicalizeMpn).filter(Boolean))];
}

/**
 * Validates a provider body against v1. Beyond the shape, every fact must be a D1 key
 * that was requested, at most once; anything else rejects the whole response.
 */
export function parseMarketFactsResponse(body: unknown, requested: string[]): ProviderFact[] {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) throw new EbayDecisionsError("EbayDecisions returned a response that is not market facts schemaVersion 1. Nothing was saved.");
  const wanted = new Set(requested);
  const seen = new Set<string>();
  for (const fact of parsed.data.facts) {
    if (fact.mpnKey !== canonicalizeMpn(fact.mpnKey) || !wanted.has(fact.mpnKey) || seen.has(fact.mpnKey)) {
      throw new EbayDecisionsError("EbayDecisions returned facts for MPNs that were not requested. Nothing was saved.");
    }
    seen.add(fact.mpnKey);
  }
  return parsed.data.facts;
}

type RequestOpts = { fetchImpl?: typeof fetch; timeoutMs?: number };

/**
 * One bearer-authenticated JSON POST. Every failure becomes an EbayDecisionsError with our own fixed
 * wording, prefixed by `step` and ending in `tail`; provider bodies and the key never reach a message.
 */
async function postJson(
  config: EbayDecisionsConfig,
  route: string,
  payload: unknown,
  words: { step?: string; tail: string; unconfigured?: string },
  timeoutMs: number,
  opts: RequestOpts
): Promise<unknown> {
  const say = (text: string) => new EbayDecisionsError(`${words.step ? `${words.step}: ` : ""}${text} ${words.tail}`);
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(`${config.url}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs)
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw say(timedOut ? "EbayDecisions did not answer in time." : "Could not reach EbayDecisions.");
  }

  if (response.status === 401) throw say("EbayDecisions rejected the integration key (401).");
  if (response.status === 503) throw say(words.unconfigured ?? "The EbayDecisions integration API is not configured on the provider (503).");
  if (!response.ok) throw say(`EbayDecisions answered ${response.status}.`);

  try {
    return await response.json();
  } catch {
    throw say("EbayDecisions returned a body that is not JSON.");
  }
}

/** One batch request for at most 100 D1 MPN keys. */
export async function fetchMarketFacts(config: EbayDecisionsConfig, mpns: string[], opts: RequestOpts = {}): Promise<ProviderFact[]> {
  const keys = batchKeys(mpns);
  if (keys.length > EBAYDECISIONS_MAX_MPNS) throw new EbayDecisionsError(`At most ${EBAYDECISIONS_MAX_MPNS} MPNs per refresh.`);
  if (!keys.length) return [];
  const body = await postJson(config, EBAYDECISIONS_ROUTE, { mpns: keys }, { tail: "Nothing was saved." }, EBAYDECISIONS_TIMEOUT_MS, opts);
  return parseMarketFactsResponse(body, keys);
}

/** True when `keys` are D1 keys covering every requested key exactly once (requested is already unique). */
function coversExactly(keys: string[], requested: string[]): boolean {
  if (keys.length !== requested.length) return false;
  const wanted = new Set(requested);
  const seen = new Set<string>();
  for (const key of keys) {
    if (key !== canonicalizeMpn(key) || !wanted.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Targeted research (A4): exact-MPN registration, then research. Dormant: nothing calls these
// until official eBay API research is activated.
// ---------------------------------------------------------------------------

/** The whole registration payload for one MPN. There is deliberately no other field. */
export type RegistrationPart = { mpn: string; description: string | null };

/**
 * Registration payload from Parts Engine's MPN index: the display MPN and description only, never
 * donors, stock, economics or machine data (donor potential is not provider inventory). The provider
 * registers the D1 key of `mpn`, so the D1 key is sent instead when the display would not map back to
 * it or exceeds the provider's bound; a description is trimmed to the provider's bound, blank as null.
 */
export function registrationPayload(rows: Array<{ mpnCanonical: string; mpnDisplay: string; description: string }>): RegistrationPart[] {
  return rows.map((row) => {
    const display = row.mpnDisplay.trim();
    const description = row.description.trim().slice(0, PROVIDER_DESCRIPTION_MAX).trim();
    return {
      mpn: display.length <= PROVIDER_MPN_MAX && canonicalizeMpn(display) === row.mpnCanonical ? display : row.mpnCanonical,
      description: description || null
    };
  });
}

const registrationSchema = z.object({
  schemaVersion: z.literal(EBAYDECISIONS_SCHEMA_VERSION),
  generatedAt: timestamp,
  results: z.array(z.object({
    mpnKey: z.string().min(1),
    mpnDisplay: z.string(),
    status: z.enum(["inserted", "existing"])
  })).max(EBAYDECISIONS_RESEARCH_MAX_MPNS)
});

export type RegistrationResult = z.infer<typeof registrationSchema>["results"][number];

/** Validates a registration body: v1 shape and exactly one result per requested D1 key. */
export function parseRegistrationResponse(body: unknown, requested: string[]): RegistrationResult[] {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success || !coversExactly(parsed.data.results.map((r) => r.mpnKey), requested)) {
    throw new EbayDecisionsError("Registration: EbayDecisions returned a response that is not part registration schemaVersion 1. Nothing was researched or saved.");
  }
  return parsed.data.results;
}

/**
 * Registers at most 20 exact MPNs (insert-only on the provider: existing parts are never touched).
 * No eBay calls happen here.
 */
export async function registerMpns(config: EbayDecisionsConfig, parts: RegistrationPart[], opts: RequestOpts = {}): Promise<RegistrationResult[]> {
  const keys = parts.map((p) => canonicalizeMpn(p.mpn));
  if (keys.some((k) => !k) || new Set(keys).size !== keys.length) throw new EbayDecisionsError("Registration needs distinct MPNs.");
  if (keys.length > EBAYDECISIONS_RESEARCH_MAX_MPNS) throw new EbayDecisionsError(`At most ${EBAYDECISIONS_RESEARCH_MAX_MPNS} MPNs per research run.`);
  if (!keys.length) return [];
  // Rebuilt field by field so nothing but the MPN and description can ever be sent.
  const payload = { parts: parts.map(({ mpn, description }) => ({ mpn, description })) };
  const body = await postJson(config, EBAYDECISIONS_REGISTER_ROUTE, payload,
    { step: "Registration", tail: "Nothing was researched or saved." }, EBAYDECISIONS_TIMEOUT_MS, opts);
  return parseRegistrationResponse(body, keys);
}

const notes = z.array(z.string().max(500)).max(10);
const researchResultSchema = z.discriminatedUnion("registration", [
  z.object({
    mpnKey: z.string().min(1),
    mpnDisplay: z.string().nullable(),
    registration: z.literal("registered"),
    sold: z.enum(["saved", "unavailable", "unverified", "failed"]),
    active: z.enum(["saved", "unavailable", "failed"]),
    overall: z.enum(["success", "partial", "failed"]),
    notes
  }),
  z.object({
    mpnKey: z.string().min(1),
    mpnDisplay: z.null(),
    registration: z.literal("unregistered"),
    sold: z.null(),
    active: z.null(),
    overall: z.literal("failed"),
    notes
  })
]);

const researchSchema = z.object({
  schemaVersion: z.literal(EBAYDECISIONS_SCHEMA_VERSION),
  generatedAt: timestamp,
  results: z.array(researchResultSchema).max(EBAYDECISIONS_RESEARCH_MAX_MPNS)
});

export type ResearchResult = z.infer<typeof researchResultSchema>;

/** The provider's rule: success = both streams saved, partial = one, failed = none. */
const overallOf = (r: ResearchResult) => {
  const saved = (r.sold === "saved" ? 1 : 0) + (r.active === "saved" ? 1 : 0);
  return saved === 2 ? "success" : saved === 1 ? "partial" : "failed";
};

/**
 * Validates a research body: v1 shape, exactly one result per requested D1 key, and an `overall`
 * that agrees with the sold/active outcomes. Outcomes are only reported; nothing here is persisted.
 */
export function parseResearchResponse(body: unknown, requested: string[]): ResearchResult[] {
  const parsed = researchSchema.safeParse(body);
  if (!parsed.success || !coversExactly(parsed.data.results.map((r) => r.mpnKey), requested) || parsed.data.results.some((r) => r.overall !== overallOf(r))) {
    throw new EbayDecisionsError("Research: EbayDecisions returned a response that is not targeted research schemaVersion 1. No research outcome was read.");
  }
  return parsed.data.results;
}

/**
 * Asks EbayDecisions to research at most 20 registered exact MPNs through the official eBay APIs.
 * The provider saves what it verifies; read the stored facts afterwards with fetchMarketFacts.
 */
export async function researchMpns(config: EbayDecisionsConfig, mpns: string[], opts: RequestOpts = {}): Promise<ResearchResult[]> {
  const keys = batchKeys(mpns);
  if (keys.length > EBAYDECISIONS_RESEARCH_MAX_MPNS) throw new EbayDecisionsError(`At most ${EBAYDECISIONS_RESEARCH_MAX_MPNS} MPNs per research run.`);
  if (!keys.length) return [];
  const body = await postJson(config, EBAYDECISIONS_RESEARCH_ROUTE, { mpns: keys }, {
    step: "Research",
    tail: "No research outcome was read.",
    unconfigured: "EbayDecisions cannot research: its integration API or eBay credentials are not configured (503)."
  }, EBAYDECISIONS_RESEARCH_TIMEOUT_MS, opts);
  const results = parseResearchResponse(body, keys);
  // Provider notes are fixed provider wording; drop any that would echo our key, as a last guard.
  return results.map((r) => ({ ...r, notes: r.notes.filter((n) => !n.includes(config.apiKey)) }));
}

export type ResearchCounts = {
  inserted: number;
  existing: number;
  soldSaved: number;
  activeSaved: number;
  soldUnavailable: number;
  soldUnverified: number;
  /** Research saved nothing for these MPNs (neither sold nor active). Includes unregistered. */
  failed: number;
  unregistered: number;
  /** Distinct provider notes with how many MPNs carried each. */
  notes: Array<{ note: string; count: number }>;
};

export function researchCounts(registration: RegistrationResult[], research: ResearchResult[]): ResearchCounts {
  const notes = new Map<string, number>();
  for (const r of research) for (const n of new Set(r.notes)) notes.set(n, (notes.get(n) ?? 0) + 1);
  const count = (p: (r: ResearchResult) => boolean) => research.filter(p).length;
  return {
    inserted: registration.filter((r) => r.status === "inserted").length,
    existing: registration.filter((r) => r.status === "existing").length,
    soldSaved: count((r) => r.sold === "saved"),
    activeSaved: count((r) => r.active === "saved"),
    soldUnavailable: count((r) => r.sold === "unavailable"),
    soldUnverified: count((r) => r.sold === "unverified"),
    failed: count((r) => r.overall === "failed"),
    unregistered: count((r) => r.registration === "unregistered"),
    notes: [...notes].map(([note, n]) => ({ note, count: n }))
  };
}

export type MarketFactsPlan = {
  sold: ProviderSoldPatch[];
  active: ProviderActivePatch[];
  refreshed: string[];
  noSold90: string[];
  unregistered: string[];
  failed: string[];
};

/**
 * Maps validated provider facts to the provider-owned market_facts fields only.
 *
 * - `sold90` → sold_90 / sell_through_pct (+ `research` provenance when non-null) / researched_at
 *   (the SOLD capture date) / source. Nulls stay null; nothing is derived.
 * - `sold90.avgSoldPrice` / `avgBuyerShipping` → avg_price / avg_ship only when `priceBasis` is
 *   "sold". For "asking" or "unknown" they are dropped: existing confirmed price/shipping are kept
 *   and a new row leaves them null. Active asking price is never substituted.
 * - `active` → active_qty only. Asking price/shipping are not persisted in A2.
 * - No `sold90`: sold facts and researched_at are left untouched, so a newer active snapshot
 *   can never make old or missing sold research look fresh.
 * - `unregistered`, or a requested key the provider did not return: nothing is written.
 */
export function planMarketFacts(requested: string[], facts: ProviderFact[]): MarketFactsPlan {
  const byKey = new Map(facts.map((f) => [f.mpnKey, f]));
  const plan: MarketFactsPlan = { sold: [], active: [], refreshed: [], noSold90: [], unregistered: [], failed: [] };
  for (const key of batchKeys(requested)) {
    const fact = byKey.get(key);
    if (!fact) { plan.failed.push(key); continue; }
    if (fact.status === "unregistered") { plan.unregistered.push(key); continue; }
    if (fact.sold90) {
      const s = fact.sold90;
      const priceIsSold = s.priceBasis === "sold";
      plan.sold.push({
        mpnCanonical: key,
        sold90: s.soldQty,
        priceIsSold,
        avgPrice: priceIsSold ? s.avgSoldPrice : null,
        avgShip: priceIsSold ? s.avgBuyerShipping : null,
        sellThroughPct: s.sellThroughPct,
        sellThroughSource: s.sellThroughPct == null ? null : "research",
        researchedAt: new Date(s.capturedAt).toISOString().slice(0, 10)
      });
      plan.refreshed.push(key);
    } else {
      plan.noSold90.push(key);
    }
    if (fact.active) plan.active.push({ mpnCanonical: key, activeQty: fact.active.activeQty });
  }
  return plan;
}
