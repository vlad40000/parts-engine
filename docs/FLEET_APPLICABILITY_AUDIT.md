# Fleet applicability audit · November 24, 2026

At 11:31 a.m. Eastern, the Parts Engine production snapshot contained **6,960 records across 11 statuses**. A shared model BOM was available on 4,038 records (58.0%). The reviewed evidence established a complete machine-specific list on **0 records**. The exception report contains one row for each of the 6,960 IDs. A documented exception still requires resolution.

**Physical units.** The owner-confirmed count in the adjudicated evidence is **1**. Records 6601 and 6613 identify the same Maytag unit, represented by 6613. Applying that decision leaves 6,959 records to account for. The total number of distinct physical machines remains unknown. Across the fleet, 51 candidate groups cover 227 records sharing a nonblank serial within a recorded brand and full model. Grouping trims and folds case for discovery and keeps original values in the report. A repeated identifier, especially on a record needing nameplate review, requires independent reconciliation.

## Coverage by fleet status

| Recorded status | Records | Found, nonempty model cache | Without that cache |
| --- | ---: | ---: | ---: |
| UNCHECKED | 3,832 | 2,615 | 1,217 |
| SOLD | 1,640 | 466 | 1,174 |
| PARTS ONLY | 542 | 414 | 128 |
| NEEDS PARTS | 281 | 217 | 64 |
| BEING REPAIRED | 265 | 161 | 104 |
| SCRAPED | 216 | 33 | 183 |
| READY TO SALE | 123 | 82 | 41 |
| CONSIGNMENT | 51 | 43 | 8 |
| SCRAPPED | 6 | 5 | 1 |
| PARTS PROGRAM | 3 | 1 | 2 |
| ON HOLD | 1 | 1 | 0 |
| **Total** | **6,960** | **4,038** | **2,922** |

The count follows the handoff definition of a found cache entry with a positive source row count. Eight records with a found cache have a different number of stored MPN edges than reported cache rows. On 861 records the found cache reports dropped supplier rows. These counts describe the cached evidence. The audit carries the retrieval timestamp, source link, stored edge count and dropped-row count beside each applicable record.

There are 408 nameplate-review flags, 287 blank serials and 4,278 ambiguous manufacture dates. A further **197 nonblank serial fields** contain an explicit placeholder such as “NO NAMEPLATE” or “UNREADABLE”. Of the 51 repeated groups above, 16 groups covering 157 rows share placeholders. The remaining 35 groups cover 70 records with recorded serials. These categories overlap. The report keeps the full year-candidate array. One saved diagram workbook matches two records. The saved Maytag MVWB755DW0 workbook has 106 assembly/callout positions and 94 distinct printed D1 keys.

## GE GTD42EASJ2WW

**24 records, 24 nonblank serials, 23 distinct literal serials.** Machines 2415 and 6363 share a serial and remain separate fleet records pending identity review. Twelve GE records are SOLD, seven UNCHECKED, three PARTS ONLY, one NEEDS PARTS and one READY TO SALE. All 24 qualify for this audit.

The production AppliancePartsPros cache was retrieved on October 14. It reports 90 rows, zero dropped rows and five visited assembly pages. Encompass returned HTTP 403 on the preceding attempt. GE publishes five assembly sections for this exact model. The pilot captured all 94 numbered entries shown on those pages. These source counts use different units. [Supplier model page](https://www.appliancepartspros.com/parts-for-general-electric-gtd42easj2ww.html) · [GE model index](https://www.geapplianceparts.com/store/parts/assembly/GTD42EASJ2WW)

| Comparison of the 90 cached MPNs with GE's five sections | Cached MPNs |
| --- | ---: |
| Printed GE catalog number | 66 |
| Explicitly named GE service replacement only | 19 |
| Absent from those sections | 5 |

The five unmatched candidates are WD21X10261, WE1X21955, WE1X21975, WE2X21976 and WZ4X230D. They remain available for review. In the opposite direction, three GE positions lack either a catalog or replacement MPN in the cache. These are blower plate 217 (WE13X29444) and ground screw 461 (WZ05X0158, service replacement WZ5X158D) in each of two assemblies. [GE backsplash, blower and motor](https://www.geapplianceparts.com/store/parts/ModelSectionParts/GTD42EASJ2WW/1/0/0/0/BACKSPLASH%2C_BLOWER_%26_MOTOR_ASSEMBLY) · [GE cabinet and top](https://www.geapplianceparts.com/store/parts/ModelSectionParts/GTD42EASJ2WW/4/0/0/0/CABINET_%26_TOP_PANEL)

| Sample machine | Recorded serial | Status | Plausible decoded years | Serial applicability |
| --- | --- | --- | --- | --- |
| 6616 | HR839502C | SOLD | 1984, 1996, 2008, 2020 | Unresolved for all 90 candidates |
| 6664 | LM762200C | READY TO SALE | 1983, 1995, 2007, 2019 | Unresolved for all 90 candidates |

The model and engineering suffix on both records match GE's published heading. For example, GE directs belt WE12M29 at callout 213 to WE03X29897, which is the number in the supplier cache. None of the five reviewed sections supplies a serial break, build-date boundary, manufacturer-variation rule or explicit common-production rule establishing the installed belt on either unit. The same conclusion applies to all 24 records in the GE machine report. Each machine references the same reviewed catalog. A later service bulletin or unit inspection could change a position's conclusion. [GE belt entry, callout 213](https://www.geapplianceparts.com/store/parts/ModelSectionParts/GTD42EASJ2WW/1/0/0/0/BACKSPLASH%2C_BLOWER_%26_MOTOR_ASSEMBLY)

## Maytag 6613

The pilot preserves four evidence records at Top and Cabinet callout 10 on MVW6230HW1, serial CA1304279. The original factory identity remains unresolved. The observation stays on 6613 alone.

| Role | Printed MPN | Evidence |
| --- | --- | --- |
| Catalog | W11479877 | Maytag repair parts list W11497934 Rev B, page 3 |
| Supplier listed | W11543994 | AppliancePartsPros section 02, callout 10, AP7019156 |
| Observed on 6613 | W11538088 | Board marking reported in the unit evidence notes |
| Cited service replacement | W11543994 | Unit evidence notes identify the service number |

The prior acquisition preserved the first two source documents. The last two entries cite the prior evidence notes. This audit did not independently inspect a board photograph or an OEM substitution bulletin for them. The older acquisition also captured 6/6 Maytag supplier sections with two unread callouts and 5/5 OEM sections. On the separate sold GE GSS25WGTABB pilot it captured 9/9 supplier sections with ten unread rows. On LG WT7200CW, supplier captures distinguish ABWEVUS and ABWETUS drawings, while the fleet schema has no verified variation field. No LG unit received a variation by inference. [Maytag OEM document](https://assets.ajmadison.com/ajmadison/itemdocs/repair-parts-list-w11497934-revb.pdf#page=3) · [Source reconciliation and capture provenance](https://github.com/vlad40000/parts-engine/blob/40715c5b6a4a02d5b6db3acdb72efa956a3c63e6/docs/DIAGRAM_SOURCES.md)

## Schema impact and publication criteria

| Audit finding | Requirement for a later publication rehearsal |
| --- | --- |
| GE's 94 positions contain 87 distinct catalog MPNs. The same screw WE01X25535 appears at callout 75 in three assemblies. Today's model edge has one diagram field and one row per normalized model and MPN. | Add a stable component-position identity for manufacturer, exact model, reviewed variation, assembly, callout and sub-position. Store source-versioned candidate MPNs and quantities separately. Leave an unstated quantity unknown. Keep printed MPN, its D1 key and the directed replacement relation. Preserve existing MPN and machine-state keys. |
| Across 24 records, one normalized lookup key identifies multiple full spellings within a brand. Nine records with a usable cache disagree with its brand/model display label. For example, the cache label GSS25WGTA BB joins to GE GSS25WGTABB. Cache display fields are populated from the lookup request. | Verify the source document's manufacturer and literal full designation, meaningful punctuation, revision and variation before publishing to a machine. Preserve the document identity and original nameplate text. Keep candidates with unresolved collisions reviewable. |
| A complete GE catalog retrieval still leaves every pilot serial unresolved. The Maytag callout has competing evidence roles. | Track source retrieval, evaluation of required positions for a machine, and verification of those positions independently. Store document revision/date, literal rule, series and inclusive/exclusive bounds, alternatives, evidence role, reviewer and decision reason. Preserve all date candidates. Publish conflict exceptions and retain the last verified version when a refresh is partial, mismatched or stale. |
| All 135 current part-state rows, three disposition events and two numbered fleet-part events matched current edges. The machine page starts at model edges and joins the MPN master. The CSV reads the same result. An absent edge would hide a stored state from the parts list. | Read historical records independently by Machine ID and MPN. Keep unmatched rows discoverable with their sale price, listing events and repair assignment. Rehearse removal of a sold MPN and an event-only repair MPN. Keep them outside recoverable donor stock. |
| Nineteen cached GE MPNs are replacement-only matches. The Maytag observed number differs from the supplier number. Existing disposition records describe where a part went. | Gate certification of the harvested MPN for eBay on a reviewed marking, identity document or equivalent unit-specific evidence. Preserve the photo reference when available, reviewer and source. Keep predicted MPNs and documented service replacements as candidates. Rehearse a conflicting pair, including WH22X32357 and WH22X38441C, without reassigning the historical item. |

The per-machine shop-floor CSV currently has nine columns. Retain its Machine ID scope and column exclusions in regression coverage. Rehearse a separate explicitly labeled provenance export or obtain an owner decision about extending that contract. Test page/export agreement for positions and historical records. A later versioned publication should stage additions, removals and substitutions, reject stale versions and make identical retries idempotent. The production diagram migration already occupies 0009. These are follow-on design criteria. This audit executed SELECTs and wrote local reports.

## Reproducing and reading the reports

With dependencies installed and `DATABASE_URL` set to Parts Engine, run `npm run audit:fleet`. The command reads the existing schema in a read-only, repeatable-read transaction. An existing local PGlite database is also supported. To replay a snapshot containing the three allow-listed query results (`fleet`, `history`, `ge`) and `audited_at`, use `npm run audit:fleet -- --snapshot <path>`. The November 24 snapshot was read through the connected Neon project in one SELECT covering all three result sets.

The command prints a new directory under ignored `exports/`. The summary is written after the other files finish.

| File | Use |
| --- | --- |
| fleet-exceptions.csv | One row per Machine ID, including status, literal identity, cache and source evidence, date candidates, duplicate candidates and unresolved reasons |
| summary.json | Record, known physical-unit and verification denominators |
| ge-machines.csv | All exact GE records, their serials and individual applicability outcomes |
| ge-cache-comparison.csv | Every stored GE edge, printed and stored keys, all matching OEM positions, roles and source links |
| ge-catalog-positions.csv | All five sections, including repeated callouts, explicit replacement direction and positions missing from the cache |
| maytag-6613.json | Four separately attributed callout records for the identity-checked pilot unit |
| part-history.csv | Machine-scoped states and numbered events, including records whose current edge or master is missing |

This workspace predates the deployed diagram-acquisition files and has no Git metadata. The pilot used the connected repository's acquisition notes and the live database. The reusable audit runs against the supplied checkout and requires tables through migration 0009.
