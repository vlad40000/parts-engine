# Parts Engine Agent Rules

## Authority
- Inspect the current repository source, tests, migrations, and this file before editing.
- Current repository state and explicit owner instructions for the current task override older handoffs, transcripts, ZIP notes, and external summaries.
- Do not silently reinterpret or change business rules. If a requested change conflicts with current code or these rules, report the conflict before broadening scope.

## Scope
Parts Engine is the standalone fleet discovery and harvest-planning orchestrator. It has its own database and must not use cross-database foreign keys.

Other applications remain authoritative for their domains:
- **EbayDecisions:** eBay market research facts.
- **Parts Image Finder:** MPN relationships, compatibility/fitment research, and listing-package research.
- **Roadrunner Parts Ledger:** physical harvested inventory, SKU lifecycle, publishing, and realized sales/stock.
- **Appliance Inventory / App 1:** upstream machine identity and fleet intake when connected.

Parts Engine may cache or import facts from those systems, but must preserve provenance and must not silently become their source of truth.

## Durable data rules
- MPN key rule (D1): `trim -> uppercase -> strip every non-[A-Z0-9] character`.
- Preserve the original/display MPN separately from its normalized key.
- Distinct OEM part numbers remain distinct identities. Supersession/replacement/equivalence is a relationship, not normalization.
- Age bands prioritize research only. They never exclude a machine from later fitment-to-fleet matching.
- Preserve all plausible manufacture-year candidates and confidence/evidence. Do not collapse ambiguous serials to newest-year as verified fact.
- Supplier BOM membership and externally researched fitment are different evidence and must be stored/provenanced separately.
- Compatibility completeness matters: `sample`, `partial`, `complete`, and `unknown` are not interchangeable.
- Recoverable donor stock is not physical on-hand inventory.

## Privacy and repository hygiene
- Purchaser/customer PII must never be imported, committed, logged, or copied into fixtures.
- Keep secrets and runtime data out of Git: `.env*` except `.env.example`, PGlite/DB files, local imports/exports, build output, and logs.
- Do not commit production inventory workbooks or CSV exports.

## Verification
- The acceptance gate is `npm run verify` (typecheck -> tests -> production build).
- Add or update tests for behavior changes before claiming completion.
- Do not claim a limitation or failure until the relevant path has been inspected/tested.
- Keep migrations additive and collision-safe when changing identity keys; audit before adding uniqueness or NOT NULL constraints.

## Working style
- Prefer bounded implementation slices and small commits.
- Do not modify another repository unless the task explicitly includes it.
- Preserve CSV import/export as a fallback when API integrations are added.
- Do not refactor unrelated code while implementing an integration slice.
