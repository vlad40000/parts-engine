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

Parts Engine records sell-through provenance as `research` (imported) or `manual` (typed on the MPN page). The CSV/XLSX fallback import stores the source as `market_import`; the uploaded filename is never stored.

Planned primary flow:
1. ensure/register exact MPNs,
2. request research for stale/missing MPNs,
3. fetch batch market facts,
4. cache facts in Parts Engine.

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

## Authentication/environment (planned)
Expected service integration settings include:
- `PARTS_ENGINE_API_KEY`
- `EBAYDECISIONS_URL`
- `IMAGEFINDER_URL`

Exact route names and auth behavior must be read from the target repositories before implementation.
