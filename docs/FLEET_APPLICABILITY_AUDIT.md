# Fleet applicability audit · November 24, 2026

Read-only audit of whether each Fleet record has an evidence-backed parts list for its exact manufacturer, model,
serial, revision and variation. Baseline: `main` at `72c8aa7`. Production snapshot: `2026-11-24 16:31:25 UTC`
(one repeatable-read, read-only SELECT through the connected Neon project). Nothing was written to production.

**Bottom line.** A model-level BOM joins to 4,038 of 6,960 Fleet records (58.0%). **Zero records have a verified
machine-level list.** Every record carries a documented exception explaining which evidence is missing. Model-level
coverage is not serial-verified accuracy.

Design and implementation recommendations live in [SERIAL_AWARE_APPLICABILITY.md](SERIAL_AWARE_APPLICABILITY.md).

## How the figures were verified

The audit tool (`scripts/fleet-audit/`) was written by Codex. Each headline figure below was recomputed by a separate
script that does not import `report.ts`. All figures matched, with one correction: serial placeholders (197 → 204,
see below). The tool was then replayed on the same snapshot. Its output differs from Codex's original reports only in
that correction and the new supplier-comparison fields.

## Fleet coverage

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

**Why 2,922 records lack a model list.** This tells you what to act on:

| Cache state | Records | Next action |
| --- | ---: | --- |
| No cache row (never looked up) | 1,703 | Batch acquisition |
| `error` (supplier failure) | 1,138 | Retry or alternate supplier; keep failures as evidence gaps |
| `not_found` | 81 | Nameplate check, then alternate source |

**Identity exceptions.** These overlap with each other and with the table above.

| Exception | Records |
| --- | ---: |
| Flagged for nameplate review | 408 |
| Blank serial | 287 |
| Serial field holds a note, not a serial (no digit: "NO NAMEPLATE" 183, "UNREADABLE" 10, "NO SERIAL" 3, "NEW" 3, "WORE OFF" 2, and others) | 204 |
| Ambiguous manufacture date (several plausible decoded years) | 4,278 |
| No date candidate | 1,400 |
| One lookup key covering several full spellings within a brand | 24 |
| Found cache whose display label differs from the Fleet spelling | 9 |
| Found cache whose stored edge count differs from its row count | 8 |
| Found cache reporting dropped supplier rows | 861 |

All nine label mismatches are separator-only (`GSS25WGTA BB` vs `GSS25WGTABB`, `WMH78019HZ-0` vs `WMH78019HZ0`, Samsung
`WF42H5000AW/A2-11` vs `/A211`). The lookup key treats them as equal. Publication must not.

All eight edge-count mismatches are Kenmore lists with exactly one more cache row than stored edge. This is consistent
with `saveModelBom` keeping one edge per canonical MPN.

**Physical units.** 51 groups share a nonblank serial within a brand and full model (227 records). Of these, 16 groups
(157 records) share a placeholder note. The other 35 groups (70 records) are pairs with a real serial. Some pairs
combine a SOLD record with an active one; that is a re-intake candidate, not proof of a duplicate. The owner has
confirmed one pair, 6601 = 6613. So the known count is **6,959 records after confirmed duplicates**. The number of
distinct physical machines remains unknown, and no record was merged or deleted.

**Part history.** There are 140 machine-scoped rows: 135 current states (125 failed, 9 pulled, 1 pulled-and-sold),
3 disposition events and 2 fleet-part events, across 66 machines. All 140 currently match a visible edge. That is
luck, not a guarantee; see "Historical parts visibility" below.

## GE GTD42EASJ2WW pilot

**Fleet scope.** There are 24 records (SOLD 12, UNCHECKED 7, PARTS ONLY 3, NEEDS PARTS 1, READY TO SALE 1). All 24
have nonblank serials, and there are 23 distinct literal serials. Machines 2415 and 6363 are both SOLD, both have
identity status `ok`, and both record serial `LG720202C`. They stay separate records pending identity review. All 24
share one AppliancePartsPros cache, retrieved 2026-10-14, with 90 rows, 90 edges and 0 dropped.

**Sources and their limits.**

- **GE OEM** (`ge-catalog.json`). Five sections (Backsplash/Blower/Motor 36, Front Panel & Door 23, Water System 4,
  Cabinet & Top Panel 13, Drum 18) give 94 positions and 87 distinct catalog MPNs. Codex transcribed them by hand on
  2026-11-24. **No raw page was preserved.** On re-check, every geapplianceparts.com URL returned HTTP 403 to scripted
  requests. The `publishedRows` field was recorded with the same transcription, so it is not an independent check.
- **Supplier** (`ge-supplier.json`). All five AppliancePartsPros sections were re-read on 2026-11-24 and parsed with
  main's own `parseAppDiagramSection`. Each page's SHA-256 is recorded. This gives 96 callout rows and 90 distinct MPNs.

**Cached MPNs vs the GE transcription:**

| Outcome | Cached MPNs |
| --- | ---: |
| Printed GE catalog number | 66 |
| GE-named service replacement only | 19 |
| Absent from the five transcribed sections | 5 |

**Supplier rows at the same drawn position.** This corroborates the transcription independently. Of the 94 GE
positions:

| Supplier's number at that callout | Positions |
| --- | ---: |
| Same as GE's catalog number | 70 |
| Same as GE's named replacement | 20 |
| A different number (competing claim) | 2 |
| Supplier prints nothing there | 2 |

**The five unmatched MPNs, identified:**

| MPN | Supplier section, callout | Supplier description | Reading |
| --- | --- | --- | --- |
| WD21X10261 | Backsplash, "N/I" (not illustrated) | Interlock Switch (AP3994765) | Supplier-only. Not on GE's drawing. |
| WE1X21955 | Cabinet & Top Panel, 417 | Dryer Fuse Holder (AP5982568) | On the supplier's drawing; absent from the GE transcription |
| WE1X21975 | Cabinet & Top Panel, 418 | Dryer Thermal Fuse (AP5957584) | Same as above |
| WE2X21976 | Cabinet & Top Panel, 254 | 6-20 Screw (AP6032721) | Same as above |
| WZ4X230D | Backsplash 461 and Cabinet 461 | Mounting Screw 12-Pack (AP2614385) | **Competing claim.** GE prints WZ05X0158 → replacement WZ5X158D at 461 |

Callouts 254, 417 and 418 are drawn by the supplier, but Codex's GE capture does not list them. It cannot be
determined from here whether GE dropped them or the transcription missed them, because GE returns HTTP 403. Re-check
them with a browser capture before treating the thermal fuse and fuse holder as non-applicable.

**Other positions.**

- Backsplash 217 (blower plate WE13X29444) has no supplier row and no cache counterpart.
- WE01X25535 (panel screw) is drawn at callout 75 in three assemblies by both GE and the supplier, but it is stored as
  **one** edge. `model_part_edges` is keyed by model and MPN, so it cannot hold the other two positions.

**Supplier drift since the cache.** The cache holds WE1M1015, GE's catalog number at Drum 515. The live supplier page
now prints the GE-named replacement WE13X29439 there instead. This is the case the review warns about: a refresh would
silently swap the catalog MPN for the replacement.

**Serial applicability.**

| Sample | Serial | Status | Plausible years | Outcome |
| --- | --- | --- | --- | --- |
| 6616 | HR839502C | SOLD | 1984, 1996, 2008, 2020 | Unresolved for all 90 candidates |
| 6664 | LM762200C | READY TO SALE | 1983, 1995, 2007, 2019 | Unresolved for all 90 candidates |
| 2415 / 6363 | LG720202C (shared) | SOLD / SOLD | 1980, 1992, 2004, 2016 | Unresolved; identity review first |

The transcribed sections carry no serial break, build-date boundary, variation rule or explicit common-production
statement. For example, GE directs belt WE12M29 at 213 to WE03X29897, and both the cache and the supplier list
WE03X29897. But nothing establishes which belt was installed on either unit. Every GE record is unresolved.

## Maytag MVW6230HW1 · machine 6613

6613 (PARTS ONLY, serial CA1304279) is the pilot unit. 6601 (BEING REPAIRED, same serial) is the owner-confirmed
duplicate and is excluded from the physical count. Both share a 114-row found cache. Neither has a saved diagram in
production; that import is PR #52.

Top and Cabinet callout 10. The four records are read from the committed `machine6613` evidence in
`test/fixtures/diagrams/results.json`, not restated:

| Role | MPN | Scope | Source | Verified here |
| --- | --- | --- | --- | --- |
| catalog | W11479877 | model | Maytag repair parts list W11497934 Rev B, p.3 | Yes: committed OEM fixture line `10 W11479877 Control Unit Assembly` |
| supplier_listed | W11543994 | model | AppliancePartsPros 02 Top and Cabinet #10, AP7019156 | Yes: committed APP fixture row links `…w11543994-ap7019156.html` |
| observed | W11538088 | **machine 6613 only** | none (handoff evidence notes) | No: no photo or note in the repository |
| replacement | W11543994 | model | none (handoff evidence notes) | No: no OEM substitution document in the repository |

Factory-installed identity is unresolved. Nothing links W11479877 → W11538088 → W11543994 as a supersession chain.

## Historical parts visibility (confirmed gap)

`test/historical-part-visibility.db.test.ts` reproduces the gap through the real write path. It saves a list, marks one
part pulled → eBay → sold at 19.00 and another failed, then saves a found refresh that omits both MPNs. The result:

- Both `machine_part_state` rows survive unchanged.
- `machineDetail()` and the per-machine CSV no longer show either part, because both start from `model_part_edges`,
  and `saveModelBom` deletes and rewrites every edge on a found refresh.
- The page's disposition-history panel still shows the eBay and sold events. The failed part has no event, so **nothing
  on the page shows it**. 134 of the 135 production states are of that kind (no disposition events).
- The audit's history query finds all four rows as `unmatched historical MPN`.

The test pins current behavior. The fix must flip its "hidden" assertions and keep its storage assertions.

## Reproducing

```sh
npm ci
DATABASE_URL=<parts engine db> npm run audit:fleet         # read-only, repeatable-read; or pglite:<dir>
npm run audit:fleet -- --snapshot <audit-input.json>        # replay a saved {audited_at, fleet, history, ge}
```

Output goes to a new directory under ignored `exports/`. `summary.json` is written last.

| File | Contents |
| --- | --- |
| fleet-exceptions.csv | One row per Machine ID: status, literal identity, cache evidence, date candidates, duplicate candidates, reasons |
| summary.json | Record, physical-unit, cache-state and verification denominators; GE source comparisons |
| ge-machines.csv | The 24 GE records and their outcomes |
| ge-cache-comparison.csv | Each cached GE MPN: OEM positions matched, live supplier positions, outcome |
| ge-catalog-positions.csv | Each of the 94 GE positions: catalog, replacement, cache presence, supplier number and agreement |
| maytag-6613.json | The four callout-10 records with scope and source |
| part-history.csv | Every state and event row, with whether its MPN is still on the machine's current list |

What was exercised:

- Snapshot replay (production snapshot).
- The `pglite:` path, on a disposable database migrated through `0009`. Its typo guard refuses a nonexistent directory.
- The audit and visibility tests.

The `neon` path was not exercised in this pass. The snapshot itself was taken through the connected Neon project.

Production-derived inputs and reports stay out of Git (`/local/`, `/exports/` are ignored).
