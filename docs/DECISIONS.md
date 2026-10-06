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

## Economic qualification: Store Economics v7 (PE-4)
- Roadrunner Store Economics v7 is the current qualification model (`src/lib/economics.ts`), replacing the prototype GREENLIGHT rule (25% all-in fee, $20 cushion, $1 minimum profit, 20% sell-through, sold/active share ranking and pull cap). Those columns stay in `settings` for compatibility and drive nothing.
- There is no general minimum part price; the floor is the per-part break-even.
- Exact-MPN 90-day sell-through is a research/manual input with provenance (`market_facts.sell_through_source`). It is never derived from sold_90 and active_qty.
- Qualification is `SET_RULE` until the owner enters both minimum sell-through % and minimum projected profit margin %. Do not choose these for the owner.
- The ordinary 90-day sold minimum is 3; an approved strategic exception waives only that gate.
- Teardown ranking is disabled while the rules are unset; once set, only QUALIFIED MPNs enter it, ordered by modeled value / slot-day, with no pull cap or stock target.
- Physical harvest-candidate classification (PE-3) is independent of economics.
- v7 planning assumptions (fees, shipping label, labor, machine-type overhead) are editable settings, never literals.

## Existing inherited behavior requiring explicit review before expansion
The delivered baseline currently excludes compressors before eBay research. Leave this behavior unchanged unless a dedicated owner decision changes it; do not generalize it into a broader automatic scrap policy.

## Open gaps
- EbayDecisions and Image Finder pending patches use a pre-D1 key rule and must be aligned before API wiring.
- EbayDecisions market-facts needs exact-MPN 90-day sell-through plus provenance.
- The owner has not yet set the two qualification thresholds.
- Purchased-new (non-harvested) economics are not modeled.
- Live stock-on-hand integration from Ledger is not implemented.
- External fitment edges are not yet stored separately in Parts Engine.
- PartSelect and PartsDr parsers await raw fixtures.
- Dishwasher/microwave removal-minute baselines are incomplete.
- Model-production/Wayback evidence does not yet narrow age candidates.
- Automatic whole-machine vs harvest vs scrap disposition is not implemented.
- App 1 source has not been integrated into this repository.
