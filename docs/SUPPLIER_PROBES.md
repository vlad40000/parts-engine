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
