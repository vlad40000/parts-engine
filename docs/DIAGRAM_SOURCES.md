# Diagram source acquisition pilot (2026-11-23)

Spike branch `spike/diagram-source-acquisition`. Read-only: no database writes, no migration, no importer change.
The goal is reproducible, exact-model assembly diagram evidence (sections, drawings, callouts, part numbers) that
Codex in Work can review and stage. Production imports stay on the existing operator-key workbook path (PR #47).

## What the branch adds

| Path | Purpose |
|---|---|
| `src/sources/diagrams/types.ts` | Evidence model: one `DiagramAttempt` per brand + full model (+ variation) + provider. |
| `src/sources/diagrams/outcome.ts` | HTTP/challenge classification, distinct-row rule, `complete` / `partial` / `blocked` rule. |
| `src/sources/diagrams/appliancepartspros.ts` | APP assembly pages: drawing, callout label per row. Reuses the BOM identity guards. |
| `src/sources/diagrams/oem-parts-list.ts` | Whirlpool-family repair parts list (PDF text): cover models, drawing page, parts key, finish sub-rows, unillustrated pages. |
| `src/sources/diagrams/homedepot-variation.ts` | Home Depot Repair Parts (Eldis) per manufacturer variation (LG `MFGModelNumber`). |
| `src/sources/diagrams/encompass.ts` | Encompass PartStore model page → public exploded view (assemblies and ARI drawings). |
| `src/sources/diagrams/reconcile.ts` | Catalog vs supplier, section by section and callout by callout; differing numbers kept side by side. |
| `test/diagram-sources.test.ts` | Offline tests and the golden dataset check (27 tests). |
| `test/diagram-source-probe.local.test.ts` | Local network probe and fixture builder (skipped unless enabled). |
| `test/diagram-sources-support.ts` | Cases, fixture minimizer, replay fetcher, results builder. |
| `test/fixtures/diagrams/` | Minimized captures, manifests, OEM parts-list text, source-only captures, `results.json`. |

## Evidence model

- **Attempt**: brand, full model as written on the fleet record, manufacturer variation (LG), provider, confirmed
  source URL, retrieval time, how identity was proven or refused, expected vs retrieved sections, retrieved callout
  rows, every fetch with status and outcome, `missing` (each unread section with its reason), outcome, reason.
- **Section**: assembly title as published, the page the rows came from, full-size drawing URL (or `null` when the
  source publishes the section without one), callout rows, `uncalloutedRows` (listed with no label: featured
  accessories, optional parts), `unreadRows` (listed with a label but no readable OEM number), exact repeats dropped.
- **Callout row**: label as a string (`"10"`, `"9A"`, `"NI"`, `"F032"`), part number exactly as printed
  (`supplierMpn`), D1 key derived separately (`mpnKey`), description, retail id (AP…, HD…; never an MPN), sub-row label
  (finish such as `White`, or a literature item).
- The same part number at several callouts, and several part numbers at one callout, are all kept. Only an exact
  repeat (same callout, MPN, retail id, sub-row) is kept once and counted.
- **Outcomes.** `complete`: exact identity confirmed and every section the source publishes for it was read. This is
  completeness *against that source*, not proof of the installed OEM BOM. `partial`: identity confirmed, some published
  sections or callouts not read (listed in `missing`). `blocked`: nothing usable (access refused, page missing, identity
  unproven or for another model), with the reason; nothing from a blocked attempt is kept.
- Catalog, supplier-listed, observed and replacement numbers are separate records with their own evidence
  (`machine6613` in `results.json`). Supersession is never inferred from a supplier printing a different number.

## Reproduce

Offline (CI and `npm run verify`): the dataset is rebuilt from the committed fixtures and compared byte for byte.

```bash
npx vitest run test/diagram-sources.test.ts
UPDATE_DIAGRAM_RESULTS=1 npx vitest run test/diagram-sources.test.ts   # rewrite results.json after a deliberate change
```

Network (local only, never in CI):

```bash
DIAGRAM_PROBE=live npx vitest run test/diagram-source-probe.local.test.ts                     # capture, no fixture writes
DIAGRAM_PROBE=live DIAGRAM_PROBE_WRITE_FIXTURES=1 npx vitest run test/diagram-source-probe.local.test.ts
DIAGRAM_PROBE=raw  DIAGRAM_PROBE_WRITE_FIXTURES=1 npx vitest run test/diagram-source-probe.local.test.ts   # rebuild from the last capture, no network
DIAGRAM_PROBE_CASES=maytag-mvw6230hw1 …                                                     # limit cases
DIAGRAM_SOURCE_ONLY_DIR=/path/to/raw npx vitest run test/diagram-source-probe.local.test.ts   # minimize hand captures listed in index.json
```

- GET only, through `src/sources/http.ts` `createFetcher`: one request in flight per host, 2 s between request starts,
  20 s timeout, no retries, no POST, no login, no challenge solving. A 401/403/429, bot-check page, 404 or redirect to
  another model is recorded as the outcome. After a 403/429 the attempt stops requesting that host.
- Raw responses and a raw manifest go to `local/diagram-probe/<case>/` (gitignored). Fixtures are minimized to the
  elements the parsers read, and are written only after replaying them gives exactly the evidence the full pages gave.
- The OEM PDF is converted with `pdftotext -raw -enc UTF-8` (Xpdf 4.00 on the capture machine; poppler also works),
  normalized to LF. The PDF's SHA-256 and size are in the manifest.
- The live run used for these fixtures: maytag-mvw6230hw1 2026-11-23T16:50:49.641Z, ge-gss25wgtabb 2026-11-23T16:51:06.084Z, kenmore-790-91319013 2026-11-23T16:51:25.760Z, lg-wt7200cw-abwevus 2026-11-23T16:51:28.832Z. It made 28 page requests plus one PDF download.

## Results matrix

| Case | Machine (status) | Brand, model, variation | Provider | Confirmed source | Sections read / published | Callout rows | Unread | Outcome | Reason |
|---|---|---|---|---|---|---|---|---|---|
| maytag-mvw6230hw1 | 6613 (PARTS ONLY) | Maytag MVW6230HW1 | appliancepartspros | https://www.appliancepartspros.com/parts-for-whirlpool-mvw6230hw1.html | 6 / 6 | 116 | 2 | **complete** | All 6 published sections read for the confirmed identity. |
| maytag-mvw6230hw1 | 6613 (PARTS ONLY) | Maytag MVW6230HW1 | encompass | — | 0 / ? | 0 | 0 | **blocked** | No confirmed Encompass exploded view: https://partstore.encompass.com/model/WHIMVW6230HW1: HTTP 403 access refused; https://partstore.encompass.com/model/MAYMVW6230HW1: HTTP 403 access refused. |
| maytag-mvw6230hw1 | 6613 (PARTS ONLY) | Maytag MVW6230HW1 | oem-parts-list | https://assets.ajmadison.com/ajmadison/itemdocs/repair-parts-list-w11497934-revb.pdf | 5 / 5 | 91 | 0 | **complete** | All 5 published sections read for the confirmed identity. |
| ge-gss25wgtabb | 2121 (SOLD) | GE GSS25WGTABB | appliancepartspros | https://www.appliancepartspros.com/parts-for-ge-gss25wgtabb.html | 9 / 9 | 234 | 10 | **complete** | All 9 published sections read for the confirmed identity. |
| ge-gss25wgtabb | 2121 (SOLD) | GE GSS25WGTABB | encompass | — | 0 / ? | 0 | 0 | **blocked** | No confirmed Encompass exploded view: https://partstore.encompass.com/model/HOTGSS25WGTABB: HTTP 403 access refused. |
| kenmore-790-91319013 | 4435 (SCRAPPED) | Kenmore 790.91319013 | appliancepartspros | — | 0 / 4 | 0 | 0 | **blocked** | Section https://www.appliancepartspros.com/backguard-parts-for-kenmore-79091319013.html loaded a page for Kenmore 790.91319013 (79091319013, 790 91319013), not Kenmore 790.91319013; the section list is not provably this model's, so nothing was kept. |
| kenmore-790-91319013 | 4435 (SCRAPPED) | Kenmore 790.91319013 | encompass | — | 0 / ? | 0 | 0 | **blocked** | No confirmed Encompass exploded view: https://partstore.encompass.com/model/KMR79091319013: HTTP 403 access refused. |
| lg-wt7200cw-abwevus | none yet (variation pending) | LG WT7200CW ABWEVUS | homedepot | — | 0 / ? | 0 | 0 | **blocked** | Variation overview not read: HTTP 403 access refused at https://www.appliancerepair.homedepot.com/Models/WT7200CW/MFGModelNumber/ABWEVUS/. |
| lg-wt7200cw-abwevus | none yet (variation pending) | LG WT7200CW ABWEVUS | appliancepartspros | — | 0 / ? | 0 | 0 | **blocked** | https://www.appliancepartspros.com/parts-for-lg-wt7200cw.html names LG WT7200CW but no manufacturer variation, so it cannot be shown to be ABWEVUS; nothing was read. |
| lg-wt7200cw-abwevus | none yet (variation pending) | LG WT7200CW ABWEVUS | encompass | — | 0 / ? | 0 | 0 | **blocked** | No confirmed Encompass exploded view: https://encompass.com/model/ZENWT7200CW: HTTP 403 access refused; https://partstore.encompass.com/model/LGEWT7200CW: HTTP 403 access refused. |

`unread` = rows the source listed at a callout without a readable OEM number (kept with label and retail id, never
guessed). Maytag APP: callouts 1 and 1A (literature; the link reads `/whirlpool-w11197727-owners-manual-ap7997642.html`).
GE APP: the refrigerator water filter (AP5788185, link `/ge-ref-water-filter-mwfp-ap5788185.html`), listed without a
label in every section and at callout 790 in Fresh Food Section.

### Machine 6613, top and cabinet callout 10

| Role | Part number | D1 key | Evidence | Source |
|---|---|---|---|---|
| catalog | W11479877 | W11479877 | Maytag repair parts list, TOP AND CABINET PARTS, Illus. No. 10 (Control Unit Assembly, Machine and Motor) | https://assets.ajmadison.com/ajmadison/itemdocs/repair-parts-list-w11497934-revb.pdf#page=3 |
| supplier_listed | W11543994 | W11543994 | AppliancePartsPros 02 - Top And Cabinet, callout 10 (Electronic Control Board, AP7019156) | https://www.appliancepartspros.com/02-top-and-cabinet-parts-parts-for-whirlpool-mvw6230hw1.html |
| observed | W11538088 | W11538088 | Board physically read on machine 6613. Machine 6613 evidence notes, as cited in the 2026-11-23 diagram handoff; not fetched or re-verified by this probe | — |
| replacement | W11543994 | W11543994 | Current service replacement. Machine 6613 evidence notes, as cited in the 2026-11-23 diagram handoff; not fetched or re-verified by this probe | — |

The catalog and supplier numbers are read from the fixtures. The observed board and the service replacement are
from the 6613 evidence notes cited in the handoff and were not fetched or re-verified by this probe.

### Maytag MVW6230HW1: OEM parts list vs AppliancePartsPros

| Section | Catalog callouts | APP callouts | Same number | Different number | Missing at APP | Unread at APP |
|---|---:|---:|---:|---:|---|---|
| TOP AND CABINET PARTS | 40 | 39 | 5 | 34 | none | 1 |
| CONSOLE PARTS | 8 | 8 | 1 | 7 | none | none |
| BASKET AND TUB PARTS | 14 | 14 | 3 | 11 | none | none |
| GEARCASE, MOTOR AND PUMP PARTS | 18 | 18 | 1 | 17 | none | none |
| OPTIONAL PARTS (NOT INCLUDED) (unillustrated, by number) | 29 numbers | 30 numbers | 27 shared | catalog only: 285195, W10135699; APP only: WP285195, W10549845, W10501250 | — | — |

APP prints the current service number at most callouts (in top and cabinet, 34 of the 39 callouts both sides list
carry a different number from the 2021 catalog; callout 10 lists W11543994 where the catalog lists W11479877). APP diagrams are therefore evidence of where a
*service* part sits on the drawing, not of the original catalog number. Section `01 - Cover Sheet` has no catalog
counterpart. In optional parts, APP `WP285195` and catalog `285195` stay distinct (D1 does not strip WP prefixes).

### LG WT7200CW variation check (source-only fixtures)

The scripted probe was refused (HTTP 403) by Home Depot for both variations, by both Encompass hosts, and APP names
`WT7200CW` with no variation. Earlier the same day, plain manual GETs of the Home Depot pages returned 200 (the first
ABWEVUS request returned a bot-check page; the second, about four minutes later, returned the page). Those captures are
kept as source-only fixtures in `test/fixtures/diagrams/source-only/` with `provenance.json` (URL, time, method, raw
SHA-256). No further requests were made to work around the probe refusals.

- `WT7200CW (ABWEVUS) LG Washer - Overview` is accepted only for ABWEVUS; the ABWETUS overview is refused for ABWEVUS
  by its own canonical link and heading, even when served at the ABWEVUS address.
- Both variations list the same three assemblies, but the Top Cover drawing differs (`578D3CAD…` vs `4E8A08BF…`). A
  section page must show the drawing its own variation's overview links, or the whole attempt is refused.
- Outer Case Assembly (ABWEVUS) parses to 19 distinct callout rows (labels `F000`…`F100`), three callouts with two
  part numbers each (`F032`, `F070`, `F086`) and one exact repeat (`F018`).
- Tests cover a 429 part-way (partial; the remaining section is not requested), 404 sections (partial), a section with
  another drawing, a cross-variation link and an overview redirect (all refused, nothing kept).

## Findings and conflicts for review

1. **Kenmore identity guard (pre-existing, also affects BOM lookups).** APP heads Kenmore section pages
   `Parts for Kenmore 790.91319013 (79091319013, 790 91319013): Backguard Parts`. `appSectionIdentity` in
   `src/sources/identity.ts` reads the parenthetical alias list as part of the model and refuses the page, so the
   Kenmore case is `blocked`. The BOM lookup uses the same guard. A fix (accept a parenthetical that lists only
   spellings of the same model token) changes BOM behaviour and is left for a separate reviewed change. The refusal is
   pinned by a test.
2. **APP OEM numbers in link slugs.** `oemFromSlug` only reads an OEM number at the end of the slug. Rows like
   `/whirlpool-w11197727-owners-manual-ap7997642.html` are left unread (kept with their callout), in both the diagram
   reader and, as before, the BOM reader.
3. **Encompass callouts.** The PartStore exploded view (`/Exploded-View-Assembly/WHI/2619720/MVW6230HW1`) is a public
   GET page listing all six assemblies with ARI drawings on `cdn.datamanager.arinet.com`. Callouts and part rows are
   loaded by its script from `POST /shop/api/ari/?action=getAssemblyInfo`, an undocumented endpoint this probe does not
   call. With the source-only captures the Encompass reader returns `partial` (6/6 drawings, 0 callout rows) and says
   why. Using that endpoint needs Encompass's permission; the existing workbook route (PR #47) remains the Encompass path.
4. **Scripted access to Cloudflare-fronted suppliers.** `partstore.encompass.com`, `encompass.com` and Home Depot Repair
   Parts answered the probe (Node `fetch`) with 403 on 2026-11-23, while plain manual GETs earlier the same day got 200.
   `createFetcher` discards non-2xx bodies, so the probe cannot tell a challenge from a plain refusal. Treat these hosts
   as unavailable for unattended batches unless the supplier authorizes access (the Marcone account route in PR #45's
   notes is the candidate for authorized data).
5. **Sears PartsDirect** (reconnaissance only): the exact `maytag-mvw6230hw1` page reports 118 parts over 12 pages and
   exposes original vs substitute part numbers; per-section schematic URLs are not in its static HTML. PR #45's parser
   is the starting point; it is not wired into this pilot.
6. **Importer fit.** The production importer accepts only the Encompass workbook format. A staged APP or OEM bundle needs
   a separate importer change (Work), including how to show supplier-listed vs catalog numbers on the machine page.

## Bundles ready for a staging rehearsal

- **Maytag MVW6230HW1** (machine 6613): APP `complete` (6/6 sections, 116 callout rows, 2 unread) and OEM parts list
  W11497934 Rev. B `complete` (5/5 sections, 91 rows), reconciled. Catalog and supplier numbers must stay separate.
- **GE GSS25WGTABB** (machine 2121, SOLD; model found only on off-lot records): APP `complete` (9/9 sections,
  234 callout rows, 10 unread).
