import "server-only";
import { z } from "zod";
import type { ProviderActivePatch, ProviderSoldPatch } from "@/src/db/queries";
import { canonicalizeMpn } from "./mpn";

/**
 * EbayDecisions market facts client (Integration A2).
 *
 * One explicit, user-triggered POST to EbayDecisions' merged provider route
 * `/api/integrations/market-facts` (schemaVersion 1). Service-to-service over
 * HTTPS with `Authorization: Bearer EBAYDECISIONS_API_KEY`; this module never
 * opens EbayDecisions' database and never logs or returns the key. Any response
 * that does not match v1 exactly is rejected before anything is written.
 */
export const EBAYDECISIONS_ROUTE = "/api/integrations/market-facts";
export const EBAYDECISIONS_SCHEMA_VERSION = 1;
export const EBAYDECISIONS_MAX_MPNS = 100;
export const EBAYDECISIONS_TIMEOUT_MS = 15_000;
/** market_facts.source for facts cached from the live provider. */
export const EBAYDECISIONS_SOURCE = "ebaydecisions_api";

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

/** One batch request for at most 100 D1 MPN keys. */
export async function fetchMarketFacts(
  config: EbayDecisionsConfig,
  mpns: string[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<ProviderFact[]> {
  const keys = batchKeys(mpns);
  if (keys.length > EBAYDECISIONS_MAX_MPNS) throw new EbayDecisionsError(`At most ${EBAYDECISIONS_MAX_MPNS} MPNs per refresh.`);
  if (!keys.length) return [];

  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(`${config.url}${EBAYDECISIONS_ROUTE}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ mpns: keys }),
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? EBAYDECISIONS_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new EbayDecisionsError(timedOut ? "EbayDecisions did not answer in time. Nothing was saved." : "Could not reach EbayDecisions. Nothing was saved.");
  }

  if (response.status === 401) throw new EbayDecisionsError("EbayDecisions rejected the integration key (401). Nothing was saved.");
  if (response.status === 503) throw new EbayDecisionsError("The EbayDecisions integration API is not configured on the provider (503). Nothing was saved.");
  if (!response.ok) throw new EbayDecisionsError(`EbayDecisions answered ${response.status}. Nothing was saved.`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EbayDecisionsError("EbayDecisions returned a body that is not JSON. Nothing was saved.");
  }
  return parseMarketFactsResponse(body, keys);
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
