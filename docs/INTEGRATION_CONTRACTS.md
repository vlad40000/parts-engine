# Integration Contracts

This document separates current contracts from the next planned API integration. Do not implement an undocumented cross-DB shortcut.

## Shared MPN key (D1)

```ts
export function toMpnKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
```

Examples:

```text
DC47-00019A -> DC4700019A
dc47 00019a -> DC4700019A
DC47/00019A -> DC4700019A
```

Normalization only handles representation. `W11478526` and `W11793907` remain distinct keys even when one supersedes the other.

Any migration to D1 must audit collisions before adding uniqueness or NOT NULL constraints.

## EbayDecisions -> Parts Engine market facts

Target batch contract should provide, per MPN:
- canonical/display MPN
- sold quantities for available windows (7/30/90/182-or-180/365)
- active quantity when known
- sold price evidence
- active asking-price evidence
- shipping evidence where available
- `sellThrough90`: exact-MPN 90-day sell-through, or null
- captured timestamp / provenance

Sell-through must never be derived from `sold90` and `activeQty` (Store Economics v7). When no exact value exists, send null; Parts Engine stores null and the part answers NEEDS DATA. Do not turn missing inputs into zero.

Parts Engine records sell-through provenance as `research` (imported) or `manual` (typed on the MPN page). The CSV/XLSX fallback import stores the source as `market_import`, the shared research CSV import as `shared_research_csv`; the uploaded filename is never stored.

### Live pull (A2, current)

Provider: EbayDecisions `POST /api/integrations/market-facts`, response `schemaVersion: 1` (merged at EbayDecisions `08bc1e0`). The provider is zero-write; Parts Engine never opens the EbayDecisions database.

- Config (server-only): `EBAYDECISIONS_URL`, `EBAYDECISIONS_API_KEY` (the same secret as the provider's `INTEGRATION_API_KEY`). If either is absent, the refresh button is replaced by a "not configured" note; CSV/XLSX import is unchanged.
- Trigger: MPNs → Research queue → **Refresh market facts from EbayDecisions**. Sends the D1 keys of the rendered page (max 100) in one request with `Authorization: Bearer …` and a 15 s timeout. No polling, cron, registration, or research is triggered.
- The whole response is validated (v1 shape, D1 keys, only requested keys, each at most once) before anything is written. 401/503/other errors, timeouts, and malformed bodies save nothing.
- Writes go through `patchProviderMarketFacts`, never the broad file-import upsert, and touch provider-owned fields only:

| Provider | market_facts |
| --- | --- |
| `sold90.soldQty` | `sold_90` |
| `sold90.avgSoldPrice` | `avg_price`, only when `sold90.priceBasis = sold` |
| `sold90.avgBuyerShipping` | `avg_ship`, only when `sold90.priceBasis = sold` |
| `sold90.sellThroughPct` | `sell_through_pct`; `sell_through_source = research` when non-null, else null |
| UTC date of `sold90.capturedAt` | `researched_at` |
| (with sold90) | `source = ebaydecisions_api` |
| `active.activeQty` | `active_qty` |

- `free_shipping`, `ship_cost`, `qty_on_hand`, packaging cost, removal time, strategic exception, Roadrunner sale events, and settings are never written by a refresh.
- `sold90: null`: sold facts and `researched_at` stay as they were, so a newer active snapshot never makes sold research look fresh. `active: null`: `active_qty` stays as it was.
- `unregistered`, or a requested key missing from the response (counted as failed): nothing is written; existing facts stay.
- Provider nulls are stored as null. Sell-through is never derived.
- Price basis gate: `avg_price`/`avg_ship` feed PE-4 economics as sold-price evidence, so they are written only when `sold90.priceBasis` is `sold`. For `asking` or `unknown`, `sold_90`, `sell_through_pct`, `researched_at` and `source` still update from that 90-day observation, but existing `avg_price`/`avg_ship` are kept (a new row leaves them null). `active.askingPrice`/`askingShipping` are never substituted.
- Not persisted in A2: `active.askingPrice`, `active.askingShipping`, `active.sampleSize`/`truncated`, `sold90.source`, and `sold90.priceBasis` itself (it gates the price write above but is not stored). `market_facts` has no non-conflicting columns for asking-price evidence; caching it is the next additive market-evidence extension and must not change qualification semantics.

### Shared manual-research CSV (current research path)

One file moves between Parts Engine and EbayDecisions without conversion (EbayDecisions `src/lib/shared-research-csv.ts`, merged at EbayDecisions `891279c`). Parts Engine's copy is `src/lib/shared-research-csv.ts`.

```text
mpn,description,notes,New Price,7 Day sales,7 Day Avg Price,30 Day sales,30 Day Avg Price,90 Day sales,90 Day Avg Price,90 Day Sell Through %
```

- Export (MPNs → Research queue → **Export queue CSV**): every queue row, exactly those headers in that order. `mpn` is the display MPN, or the D1 key when the display would not map back to it; `description` is clipped to 500 characters; `notes` carries donor/model counts; `New Price` is `mpn_master.new_price_min` when known. Every research column is blank, so uploading an unedited export changes no market facts and stamps no research date.
- Import (MPNs → **Import market facts**, `.csv`): a CSV with any 7/30/90 Day column is read as the shared file. Headers match ignoring case, spaces and punctuation, a superset of EbayDecisions' spellings. The whole file is validated before anything is saved, with EbayDecisions' rules for the stored columns (nonnegative plain or comma-grouped numbers, optional `$` / `%`, whole-number sales, one row per MPN, at most 5,000 rows); any problem rejects the whole file.

| Shared column | Parts Engine |
| --- | --- |
| `New Price` | `mpn_master.new_price_min`, set as supplied; blank leaves it alone |
| `90 Day sales` | `market_facts.sold_90` |
| `90 Day Avg Price` | `market_facts.avg_price` |
| `90 Day Sell Through %` | `market_facts.sell_through_pct` exactly as supplied, in percentage points (45 = 45%, 0.45 = 0.45%); `sell_through_source = research` when non-null |
| `mpn` | D1 key; aliases resolve as in the market import |
| `description` | only for an MPN new to the MPN index |
| `notes`, 7- and 30-day columns | accepted, not stored |
| optional `researched_at` / `research_date` / `date` (not in the contract) | `researched_at`; without it, the import date |

- The three 90-day values are one observation. A row that supplies any of them writes all three plus `researched_at` and `source = shared_research_csv`; a blank one is stored as null, never zero, and never filled from older facts. A row with none of them leaves `market_facts` alone, including `researched_at`.
- `avg_ship`, `active_qty`, free shipping, ship cost and qty on hand are never written by this import. Sell-through is never derived.
- The ≤ 1 → fraction rule belongs to the older formats only (`sell_through_pct`, the workbook's `Mkt 90d Sell-Through`, …), never to the shared column. A CSV mixing shared and older market columns is rejected. The shared file imports as CSV only, because a workbook cell formatted as a percent holds 0.45 for 45%.
- `sell_through_pct` is `numeric(6,2)`: values above 9,999.99 are rejected, although EbayDecisions accepts up to 100,000.
- A later parts-list read still applies `least(new_price_min, supplier price)`. `new_price_min` has no provenance column.

### Targeted research (A4, dormant)

Provider: EbayDecisions A3 (merged at EbayDecisions `761393a`): `POST /api/integrations/parts/register` and `POST /api/integrations/research`, both `schemaVersion: 1`, same bearer key. The validated client stays in `src/lib/ebaydecisions.ts` (`registrationPayload`, `registerMpns`, `researchMpns`, `researchCounts`, with tests), and `mpnRowsFor` stays as its registration source, but no page or server action calls them: Parts Engine triggers no automated eBay research. Activation waits for official eBay API access and an explicit owner decision. The one-click orchestration that used them was removed from the action layer; it is at Parts Engine `a48dcf4`. It sent only `{ mpn, description }` to registration, needed a 300 s function budget, and wrote through the A2 `planMarketFacts` → `patchProviderMarketFacts` path.

CSV import/export remains a fallback.

## Parts Image Finder -> Parts Engine relationships

Relationship records must preserve both literal MPN identities and relationship type, such as:
- supersedes
- replaced_by
- equivalent

Do not merge relationship endpoints into the D1 normalization rule.

## Parts Image Finder -> Parts Engine fitment

External fitment must be stored separately from supplier BOM membership.

Minimum fitment evidence:
- MPN key/display
- model key/display
- source/provenance
- confidence when available
- completeness: `sample | partial | complete | unknown`
- researched/captured timestamp

Only `complete` evidence may be treated as exhaustive. A sampled model list must never close the compatibility set.

Full-fitment research should be requested for market-qualified/discovery-worthy MPNs rather than every discovered MPN.

## Roadrunner sales history -> Parts Engine (CSV, current)

Roadrunner's own realized sales ("what has actually sold for us") are stored in `roadrunner_sale_events`, separate from `market_facts` ("what the wider eBay market looks like"). Neither feeds the other, and sales history does not change qualification inputs.

App-owned CSV contract (MPNs page → Import Roadrunner sales history):

```text
mpn,source_event_id,sold_at,quantity,item_price,listed_at[,days_to_sell]
```

- One row = one sale event (order line) for one MPN.
- `mpn` is stored as its D1 key plus the display text. Aliases/supersessions are not applied.
- `source_event_id` is a stable order-line/reference ID. Identity is `(source, source_event_id, mpn)` with source `roadrunner_csv`, so re-imports update in place and never double-count.
- `sold_at`, `listed_at`: `YYYY-MM-DD` or `M/D/YYYY`. `quantity`: whole units > 0. `item_price`: per unit before shipping/tax; blank = unknown.
- `days_to_sell` is used when supplied, otherwise derived from `listed_at` → `sold_at` when both are known and consistent, otherwise unknown.
- Rows with no usable MPN or no `source_event_id` are skipped and counted. All other columns, including any buyer/purchaser columns, are ignored.

Aggregate per D1 MPN (`roadrunnerPerformance`): units sold, sale events, quantity-weighted average item price, last sold date, average days-to-sell over events where it is known. An MPN with no recorded events has no aggregate (shown as "No recorded sales"), never zeros.

A future Ledger/eBay-sync API feed should write the same events under its own `source` value.

## Ledger -> Parts Engine stock (future)
A future stock-by-MPN contract should provide physical on-hand/listed/reserved facts without converting donor potential into stock.

## Authentication/environment
In use: `EBAYDECISIONS_URL`, `EBAYDECISIONS_API_KEY` (server-only; see the A2 live pull above).

Planned: `PARTS_ENGINE_API_KEY`, `IMAGEFINDER_URL`.

Exact route names and auth behavior must be read from the target repositories before implementation.
