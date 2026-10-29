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

## Tech notes (owner decisions 2026-10-29)
- Parts Engine is the record for machine status, condition, location, diagnosis, repair notes and sticker price once a tech note sets them. A workbook re-import keeps those fields (`local_fields`, `status_override`, and #31's `location_override`) and still refreshes every other field. Part-family flags only grow.
- Tech notes are read from a photo by Gemini, server-side. Owner model rule: OCR on `gemini-3.1-flash-lite`, "Re-read carefully" on `gemini-3.5-flash`, both overridable by environment variable. Typing a note by hand is the fallback when no API key is set or a read fails.
- The planner is deterministic code, not the model. Anything the reading and the record cannot settle becomes a question; nothing is written until every question is answered. Answers that map wording to a location are remembered as aliases.
- A note is applied in one SQL statement: every changed machine must still carry the version the reviewer saw, otherwise nothing is written.
- Statuses: only the Fleet status options, only when written. No status from a location; "Ready for clean" is never READY TO SALE. Off-lot statuses are confirmed.
- Parts: suspected, needed, failed, missing, replaced, removed. Needed is not failed; suspected and needed stay on pick lists marked test first.
- Chronology: the written date is the observation date. An older note never reverses a newer decision (kept as history); same-day or otherwise uncertain precedence is asked. `last_field_update_at` records the newest accepted decision.
- VERIFY LOCATION: a recorded location that conflicts with the record opens a check that only a physical verification clears; both locations stay in the history.
- Printed form: Roadrunner Standardized Field Intake (RR-F1), half sheet, one machine. Old RR-M1/RR-R1 cards and free notes are still read, no longer printed.
- Open: the layout of RR-F1 was built from the five named fields (Machine #, Date, Location, Status, Notes); no earlier approved artwork was found. Symptom rules still do not know timer, pressure sensor, damper or inner tub (part decisions mark those families test first instead). Fleet has no BEING REPAIRED status; imported machines that carry it keep it.

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
- Fleet status editing (dropdown) still offers no BEING REPAIRED; tech notes can set it. Decide whether the dropdown should match.
- Symptom rules do not yet recognize shop words such as timer, pressure sensor, damper or inner tub; tech notes mark those parts on the machine instead (failed / missing) when the part is in the model's parts list.
