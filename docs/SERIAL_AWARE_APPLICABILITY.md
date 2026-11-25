# Serial-aware applicability: design proposal

Status: **proposal**. No schema, migration or production change is made by this document. Evidence for each
requirement is in [FLEET_APPLICABILITY_AUDIT.md](FLEET_APPLICABILITY_AUDIT.md). The rules in `AGENTS.md` apply
throughout: D1 keys, distinct OEM identities, relationships rather than normalization, separate provenance for BOM
membership and researched fitment, completeness values that are not interchangeable, and additive migrations.

## What today's storage cannot express

| Need | Today | Why it fails |
| --- | --- | --- |
| Exact identity | `fleet_machines.model_key` and `model_bom_cache` join on `modelKey()` (spaces, dots, dashes removed) | `GSS25WGTA BB` and `GSS25WGTABB` are one key. A real revision separator (`/A2-11`) is folded away. |
| Variation | None | LG `ABWEVUS` and `ABWETUS` drawings differ; Fleet has no field for the variation. |
| Component position | `model_part_edges` PK = brand + model + MPN | WE01X25535 at callout 75 in three assemblies is one row. A callout with two candidate MPNs can't be represented. Quantity isn't stored. `saveModelBom` keeps only the first row per MPN. |
| Evidence role | One `mpn_display` per edge | GE 461 has catalog WZ05X0158, replacement WZ5X158D and supplier-listed WZ4X230D. Maytag callout 10 has four roles. |
| Evidence version | `saveModelBom` deletes and rewrites every edge on a found refresh | The supplier's drift WE1M1015 → WE13X29439 would replace the catalog MPN silently. Nothing keeps the prior version. |
| Applicability | Implicit: every edge applies to every machine with the key | No serial, build-date or revision rule; no per-machine outcome. |
| History | Machine page and CSV started from current edges | A sold or failed part disappeared when a refresh dropped its MPN. **Fixed:** stored part states not on the current list are now shown as historical (`historical-part-visibility.db.test.ts`). |

## Proposed model (additive; next free migration is `0010`)

Every table below is new. Nothing existing is dropped or re-keyed. `model_bom_cache` and `model_part_edges` stay as
the legacy model-level supplier evidence, labeled as such.

1. **`evidence_documents`**: one immutable row per retrieved source version.
   - Provider, kind (`oem_parts_list`, `oem_serial_document`, `service_bulletin`, `supplier_page`, `unit_observation`)
     and URL.
   - Retrieval facts: `retrieved_at`, `sha256`, bytes, raw-capture reference.
   - Document identity as printed: manufacturer, literal model designation, revision, publication date.
   - `retrieval_completeness`: `complete` | `partial` | `blocked` | `unknown`, with sections captured versus published.
   - This is **source** completeness. It says nothing about whether a machine's list is complete.
2. **`model_identities`**: exact scope for applicability.
   - `brand_key`, `exact_model` (trimmed and upper-cased, separators and revision suffix kept), `variation`, and
     `variation_state` (`not_applicable` | `required_unverified` | `verified` + evidence).
   - `model_key` stays a discovery key only.
   - A Fleet record links to an identity by Machine ID through a recorded decision: matched exactly, matched after
     review, or ambiguous. A blank or placeholder serial is never evidence of common applicability.
3. **`component_positions`**: a stable ID per identity, assembly key (printed label kept), callout as printed, and
   sub-position (the variant label).
   - Unique on (identity, assembly key, callout, sub-position).
   - An MPN at three callouts is three positions.
   - Existing edges become positions only where the evidence distinguishes them. An edge with only a `diagram_id`
     becomes a position with an unknown callout, documented as ambiguous rather than invented.
4. **`position_claims`**: immutable, one per (position, document, role, MPN).
   - Role: `catalog` | `supplier_listed` | `replacement` | `observed`.
   - The MPN as printed, plus its D1 key.
   - Quantity, which stays null when the source doesn't state it.
   - The applicability rule kept literally: kind (serial, build date or revision), series, and bounds with
     inclusive/exclusive markers.
   - `machine_no`, set only for `observed`.
   - Reviewer, review time and reason.
5. **`mpn_relations`**: replacement and supersession as directed relationships with their source document. They are
   not aliases and never re-key an MPN. `mpn_alias` stays for `wp_prefix`-style normalization only.
6. **`applicability_publications`** and **`machine_position_outcomes`**: versioned resolution.
   - A publication is staged for one identity from named documents, with a row-level diff (additions, removals,
     substitutions, new conflicts), and published with an expected-previous-version check.
   - Identical content gets an identical content hash, so a retry is a no-op.
   - A partial, blocked, mismatched-identity or stale retrieval can stage, but it cannot replace a verified version.
   - The outcome per (machine, position, publication) is `applies` | `excluded` | `unresolved` | `conflict`, with the
     selected claim, the competing claims and the rule or reason.

**Resolution.** PR #46's `resolveOriginalMpn` is the decision core. A position resolves as serial-supported only when a
reviewed OEM rule covers **every** plausible production date. Otherwise it is a candidate, a conflict or unresolved.
Model-level evidence is reused across all machines of an identity. Machine-specific resolution is layered on top.

## Three separate completeness measures

| Measure | Definition | Today |
| --- | --- | --- |
| Source retrieval | Published sections captured for a document | Per document: GE 5/5 transcribed (raw page not kept), supplier 5/5, Maytag OEM 5/5 |
| Machine applicability coverage | Known positions evaluated for the machine | 0 machines |
| Verified applicability | Evaluated, sufficient evidence, no unresolved required position | 0 machines |

Reports show all three. A `complete` retrieval never implies a complete machine list.

## Historical parts stay visible

The machine page and the per-machine CSV call one reader. That reader returns:

- the current resolved positions, and
- every `machine_part_state`, `machine_part_disposition_events` and `fleet_part_events` row for the Machine ID whose MPN
  is not on the current list.

Those rows are labeled "historical · not on current list" and keep their sale price, listing dates and repair
destination. They are not counted as recoverable donor stock. The CSV keeps its nine columns and Machine-ID scope
unless the owner approves an extension; a historical row's Description starts with
`[HISTORICAL - not on current parts list]`. A provenance export would be a separate file.

**Implemented (no migration) for current part state.** `machineDetail()` unions this machine's `machine_part_state`
rows whose MPN is not on the current edges. Disposition events were already shown by Machine ID in the page's
disposition-history panel. `fleet_part_events` are not used as a source of historical parts: a `cleared` event or an
Unlisted step deletes the state row, and reading events would bring that part back.

## Resale identity gate

The MPN on a harvested part's listing or export is **certified** only by one of:

- a reviewed physical marking on that unit (photo reference when available), or
- a reviewed document that resolves the position for that serial.

Predicted catalog MPNs, supplier-listed MPNs and service replacements are shown as candidates with their role, and are
never written as the harvested item's identity. Parts Engine records and exposes this evidence. Parts Image Finder
(listing research) and Roadrunner Ledger (SKU lifecycle) remain authoritative in their domains; nothing is pushed
across. Reassigning an existing listed or sold item's MPN is never automatic.

## Batch acquisition, with people working only the exceptions

1. Group Fleet by exact identity and order by operational need (repair and harvest statuses first, every status in
   scope).
2. Fetch, keep the raw capture with its hash, parse, and reconcile the roles per position.
3. Auto-stage. Auto-publish only when all of these hold: the identity matches exactly, the retrieval is complete, no
   new conflict appears, and nothing is removed from a verified version. Everything else goes to the exception queue,
   with the reason taken from the audit vocabulary.
4. Run resumable batches with outcome counts: processed; verified; waiting for nameplate or variation; blocked by
   source; unresolved at part level.

## Disposition of open PRs (reviewed against `72c8aa7`; none merged)

| PR | State | Recommendation |
| --- | --- | --- |
| **#42** LG manufacturer variation | Draft; conflicts in `_journal.json`, `0009_snapshot.json`, `queries.ts`; 8 commits behind | **Revise before reuse.** (1) Its `0009` collides with the deployed `0009_model_diagrams`; regenerate as `0010` or later. (2) Its migration runs `UPDATE … SET identity_status = 'needs_variation'` on every LG record that is `ok`. `identity_status = 'ok'` gates donor counts, the BOM queue and harvest candidates, so this would drop **286 LG records (162 with a found BOM)** from those paths. None of the 304 LG models carries a `.SUFFIX` the parser could read. That is a business-rule change and needs an owner decision; it is not a schema detail. (3) It encodes the variation into `model_key` (`KEY|VARIATION`). That re-keys the machine away from its current edges and hides existing part states (the visibility gap). Store the variation on the identity instead. Keep its `lg-variant` source parser and its tests. |
| **#46** Serial-aware original-MPN resolver | Draft; merges cleanly; 6 behind | **Reuse as the resolution core.** Pure functions, no persistence, ambiguity preserved. Before merging: drop the unrelated `vercel.json`, and key scope by component-position ID rather than free-text `component`. Wire it in only after the claim storage exists. |
| **#52** Maytag 6613 diagram import | Draft; merges cleanly; 1 behind (`72c8aa7`) | **Ship independently** after rebasing and a fresh Verify. It is diagram evidence for one model, not the fleet refresh. Its four callout-10 records match the committed `machine6613` evidence. |

## Prioritized plan

1. **History visibility (no migration). Done.** Added the historical union to `machineDetail()` and the export, and
   flipped the characterization test. This is the smallest slice and stops silent loss of operational history before any refresh.
2. **Evidence gaps for the pilots.** Make a browser capture of GE's five sections, re-checking callouts 254, 417, 418
   and 461, and commit it as a fixture with a hash. Commit the 6613 board photo or note reference for W11538088 and the
   OEM document for the W11543994 replacement, if one exists.
3. **Migration `0010` (additive).** Add the tables above. Rehearse on a disposable PGlite database following
   `docs/MIGRATIONS.md`. Production needs explicit owner authorization for the exact commit and migration.
4. **Pilot import.** Import the GE and Maytag evidence into positions and claims. Integrate the #46 resolver. Publish
   to a disposable database and check that the page and CSV agree for verified, partial and blocked cases.
5. **Operator surfaces.** On the machine page, show identity, list status, evidence and exceptions. Link the
   diagram-coverage group to its machines. Label the legacy cache as model-level.
6. **Batch acquisition.** Start with the 1,703 never-looked-up and 1,138 errored records. Use staged diffs and the
   exception queue.
7. **Resale identity gate.** Certified harvested MPN versus candidates.
8. **LG variation.** Use #42, revised as above, after the owner decides how `needs_variation` affects donor
   eligibility.
9. **Identity review queue.** The 35 real-serial pairs and the 16 placeholder groups. Owner adjudication only; no
   automatic merge.
