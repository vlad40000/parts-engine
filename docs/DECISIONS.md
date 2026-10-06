# Current Decisions and Open Gaps

This file records decisions evidenced by the current source and the owner's current direction. It does **not** reconstruct the missing historical D1-D12 handoff.

## Adopted
- Parts Engine remains a standalone application with its own database.
- No cross-database foreign keys.
- Batch model processing starts at 1-10 and can become configurable later.
- Supplier parts lists are HTML/source-driven, not Gemini-generated.
- Current supplier order: Encompass -> AppliancePartsPros. PartSelect/PartsDr require captured fixtures before parser work.
- D1 MPN key: uppercase and strip all non-`[A-Z0-9]` characters.
- Preserve raw/display MPN.
- Supersessions/replacements are relationships, not identity normalization.
- Age bands decide research order only.
- Ambiguous serials retain all plausible candidate years.
- MPN market research is deduplicated/cached.
- Fleet matching for a worthwhile MPN runs against the entire inventory, not only the age band that seeded discovery.
- Supplier BOM membership and external fitment are separate edge types.
- Fitment completeness/provenance must be preserved.
- Per-machine part state includes pulled/failed/missing handling; suspect failure-family parts can be test-first rather than contributing blindly to machine value.
- Removal minutes replace a synthetic 1-5 complexity score.
- API integration should become primary while CSV remains a fallback.

## Current economic defaults, not immutable constants
The delivered baseline currently exposes settings corresponding to the harvested-part greenlight model documented in the README, including sell-through threshold, fee allowance, removal labor rate and contribution cushion. Change these only through an explicit business-rule task and tests; do not bury new thresholds as literals.

## Existing inherited behavior requiring explicit review before expansion
The delivered baseline currently excludes compressors before eBay research. Leave this behavior unchanged unless a dedicated owner decision changes it; do not generalize it into a broader automatic scrap policy.

## Open gaps
- EbayDecisions and Image Finder pending patches use a pre-D1 key rule and must be aligned before API wiring.
- EbayDecisions market-facts needs 90-day sell-through plus provenance.
- Live stock-on-hand integration from Ledger is not implemented.
- External fitment edges are not yet stored separately in Parts Engine.
- PartSelect and PartsDr parsers await raw fixtures.
- Dishwasher/microwave removal-minute baselines are incomplete.
- Model-production/Wayback evidence does not yet narrow age candidates.
- Automatic whole-machine vs harvest vs scrap disposition is not implemented.
- App 1 source has not been integrated into this repository.
