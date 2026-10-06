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
- `sellThrough90`
- `sellThrough90Source: "stored" | "derived" | null`
- captured timestamp / provenance

If no stored 90-day sell-through exists, a permitted fallback is:

```text
sold90 / (sold90 + activeQty) * 100
```

only when both inputs are known. Mark it derived. Do not turn missing inputs into zero.

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

Full-fitment research should be requested for market-greenlit/discovery-worthy MPNs rather than every discovered MPN.

## Ledger -> Parts Engine stock (future)
A future stock-by-MPN contract should provide physical on-hand/listed/reserved facts without converting donor potential into stock.

## Authentication/environment (planned)
Expected service integration settings include:
- `PARTS_ENGINE_API_KEY`
- `EBAYDECISIONS_URL`
- `IMAGEFINDER_URL`

Exact route names and auth behavior must be read from the target repositories before implementation.
