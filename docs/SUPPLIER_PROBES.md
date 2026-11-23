# Read-only supplier capability probes (2026-11-16)

## Scope

Staging-only source capability audit for the six models from the November 16 audit: Maytag MVWB300WQ2, Maytag MVWB755YQ0, Whirlpool WED4616FW0, GE GSS25WGTABB, Whirlpool WFE715H0ES0, GE JB645RK4SS.

Source targets: PartSelect, Parts Dr, Sears PartsDirect, Coast / GE OEM, D&L Parts. The source runner never writes to the Parts Engine database or donor inventory.

This is deliberately not a full BOM adapter. Exact-model pages are treated only as sample evidence. sectionsDiscovered does not imply sectionsFetched (zero). High row counts and HTTP 200 responses never imply full completeness.

## Run from a staging machine

    npm ci
    node scripts/supplier-probe.mjs --output=/tmp/supplier-probe.json

Single machine / provider:

    node scripts/supplier-probe.mjs --machines=5713 --providers=partsdr,coast

On this PR, the GitHub Actions read-only supplier capability probe will execute public GET requests and upload a JSON artifact without database credentials.

## Optional APP baseline comparison

Use a strictly SELECT-only Neon/Postgres role with the environment variable PROBE_READONLY_DATABASE_URL:

    PROBE_READONLY_DATABASE_URL='postgresql://read-only-role:...@...' node scripts/supplier-probe.mjs --compare-db --output=/tmp/with-diff.json

Or pass a local JSON baseline via --baseline=/private/path/app-baseline.json with the shape:

    {"models":[{"brand":"Maytag","model":"MVWB755YQ0","mpns":["W10247710","WPW00000000"]}]}

The above is only a synthetic format example, NOT a production inventory snapshot. Never commit connection strings, raw production MPN exports or inventory files. CI reports baseline_unavailable by design; execute the comparison separately using read-only credentials.

## Outcomes

- sample_parts_found: exact model plus manufacturer confirmed and some OEM-like MPNs observed. Not a complete BOM.
- model_confirmed_no_oem_rows: exact model verified, but no OEM numbers extracted. Not evidence that the model lacks parts.
- identity_unresolved: model and manufacturer not confirmed by page title/heading; no part data accepted.
- model_detail_unresolved: D&L did not offer one unique exact-model detail link.
- blocked_403 / rate_limited_429 / challenge / http_error: host access or availability failure.
- no_verified_url: no exact model URL known for that provider; not a negative fitment claim.
- candidateMissingFromApp: sampled OEM MPN not present in the optional baseline. Review required. Never create donor edges automatically.

Retail PS/PD numbers are excluded. OEM part identities and any Replaces relation are stored separately as source observations. Independent-looking sites can share a data upstream; source agreement is not automatically independent corroboration.

## Safeguards

- All external calls use GET and an identifying user-agent. No logins, anti-bot bypass or private supplier account access.
- Sequential with one-second spacing, 12-second timeout, HTML processing cap of three MB. D&L may fetch one exact model detail page.
- Explicit host allowlist and exact full model + manufacturer identity check.
- No database connection unless --compare-db is specified with a SELECT-only connection string.
- Zero database writes even with the optional compare mode.
- No BOM cache refresh, migration, machine status change, or production deployment.

## Remaining steps

1. Verify npm run verify, then inspect real CI probe results, HTML access restrictions and parser quality.
2. Compare actual source OEM observations with all six APP cached MPN sets using SELECT-only DB access or local JSON baseline.
3. Validate W10247710 and its sourced relationship to MVWB755YQ0 without converting mere fitment into original installed OEM BOM.
4. Only then consider verified full-diagram parsers with per-section coverage and source provenance.

## Sears structured catalog — verified 2026-11-16

The older hero-page-video-main.BACKUP project contains a Sears CATALOG_API_RESPONSE parser.
The staging runner confirmed this structure in the live public HTML of all six exact test
models. Every model returned the precise normalized model number, a source-reported total,
10 referenced part records on page one, and 5–9 diagram records. Source-reported totals do
not establish complete pagination, unique OEM identities, or actual original installation.

| Machine | Sears reported parts | Cached APP edges |
|---|---:|---:|
| 5712 MVWB300WQ2 | 142 | 134 |
| 5713 MVWB755YQ0 | 160 | 148 |
| 6605 WED4616FW0 | 110 | 104 |
| 2121 GSS25WGTABB | 279 | 206 |
| 6660 WFE715H0ES0 | 156 | 147 |
| 58-1 JB645RK4SS | 105 | 87 |

Sears exposed original W10256514 for Maytag MVWB755YQ0, top-and-cabinet item 10,
and manufacturer replacement W10247710. Neither is currently represented in the
APP-derived BOM edge set for that machine. This confirms that original BOM membership
and service replacement compatibility must be retained as separate evidence.

The new Sears parser only reads verified embedded JSON, not adjacent text or retail IDs.
It keeps the original MPN, replacement MPNs, section, position and source-level expected count
separately. A model overview is always partial evidence. Page reconciliation must match
the source's pagination total and pass an exact model check before declaring a
Sears-catalog-complete retrieval (which is not OEM/physical-fitment verification).

## Marcone B2B access route

Roadrunner already has a Marcone wholesale account. Do not reapply.

Third-party EPASS documentation confirms Marcone supports account-enabled B2B web services
for price, part, inventory, warehouse quantity, sub-parts and cross-reference lookup:
https://help.epass.software/help/Integrations/Marcone/

Marcone describes parts research wizards on its National Accounts site:
https://www.marcone.com/national-accounts/

This does not yet prove that the existing account can receive complete machine-model
BOMs, exploded diagrams, or data exports. Contact official account support
https://www.marcone.com/contact-us/ to request:

1. Supported B2B endpoint documentation, sandbox, usage authorization and rate limits.
2. Exact full-model BOM/assembly diagrams (rather than MPN-only lookup), including variants.
3. Original OEM number vs service replacement chains, diagram item positions, serial applicability.
4. Permission to cache/derive fitment and use content in Parts Engine.
5. Credential management, IP restrictions and bulk access pricing.

Keep all Marcone credentials out of Git, CI and shared logs. Evaluate an authorized
data feed before broader supplier HTML scraping.
