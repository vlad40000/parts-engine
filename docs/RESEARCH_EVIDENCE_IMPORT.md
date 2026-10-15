# Research evidence imports

Use **MPNs → Save research evidence**. Choose a CSV or XLSX, declare how unmarked sell-through values are expressed, and choose whether blank sold counts mean Owner Skip for this cycle. Preview every row before selecting **Save reviewed evidence**. The original file remains selected in memory after preview. Changing the file or options requires another preview.

The existing market-facts and shared research import is unchanged. This evidence workflow never writes `market_facts`, MPN master values, removal baselines, settings, qualification, donor counts, machine-part state, Roadrunner stock, or external applications. Even a conflicting or newer observation is historical evidence only. Promotion to active facts is outside this slice.

## Supported inputs

- Owner workbook: `MPN`, `90 day sold`, `90 day sold avg price`, `90 day avg shipping`, `90 day sell through %`, `notes`.
- Consolidated master: the **Research Order** sheet, including Owner Decision, Sales Comparability, audited comparable units/item price/buyer shipping, and evidence notes. Other tabs are not merged; inherited donor-audit and copied Thin Coverage research fields remain historical.
- CSV fallback: `mpn,sold90,avgItem,avgBuyerShipping,sellThrough,sellThroughUnit,ownerDecision,salesComparability,auditedSold90,auditedAvgItem,auditedAvgBuyerShipping,observedOn,windowStart,windowEnd,auditedOn,auditedWindowStart,auditedWindowEnd,notes`. Only MPN and sold-column headers are required; values may be blank. Additional optional fields: description, incorporatedOn, auditedSellThrough, auditedSellThroughUnit.

The limit is 2 MiB and 5,000 rows. All rows validate before writing. A malformed row, duplicate exact key, duplicate resolved WP identity, invalid date, unsupported decision, conflicting skip, or invalid number rejects the whole batch. Relevant free text rejects obvious contact details; uploaded filenames and unrelated columns are not stored or logged. Keep purchaser/customer information out of source research files.

The workbook compatibility adapter operates on a temporary read copy. It handles explicitly bound SpreadsheetML element prefixes and absolute worksheet relationships, and omits VML comment-box formatting pointers that ExcelJS cannot read. Original cells, source bytes, hashes and existing workbook files are unchanged. This adapter is used only by the evidence workflow.

## Evidence semantics

- Blank sold means Owner Skip only under the selected cycle rule or an explicit Owner Skip decision. Numeric zero remains zero. Turning the rule off leaves blank evidence unreviewed/unknown.
- Research entries include comparability holds; a raw aggregate is not a verified exact-part comparable.
- Raw summaries and audited comparable subsets are stored independently, including dates/windows when supplied. An earlier audited subset never replaces a later raw search summary.
- Prices, buyer shipping and sell-through retain decimal source precision as strings. Conversion from a declared fraction to percentage points uses decimal string operations, without two-decimal rounding. A percent sign explicitly denotes percentage points; e.g. `0.45%` stays 0.45%.
- Original observed dates, raw and audited windows, master incorporation dates, and import timestamps remain separate. The master's `eBay Research Date` is retained as incorporation context; missing original dates/windows stay unknown.
- D1 identity is unchanged. The original display and input key are retained. Only an exact master key or a persisted, consistent WP identity can populate the separate resolved key. Supersession/variant relationships never merge evidence into the replacement key. Unknown identities remain visible without creating MPN master rows.
- Differences from existing active facts are shown during preview and retained in the observation. Saving never overwrites those facts. Changes to the file, selected options or active facts invalidate the preview digest and require another preview.

## Storage, retry and archive

Migration `0004_research_evidence_batches` adds only `research_evidence_batches` and `research_evidence_rows`, following PR #20's migration 0003. The feature branch and draft PR are stacked on PR #20 so migration history remains coherent. Neither production migration nor merging either PR is authorized by implementing this slice.

Preview performs SELECT queries only. Save reparses the original file and validates its current preview before issuing one atomic batch/observations CTE. If any observation insertion fails, the parent batch rolls back. The file SHA-256 is unique. Repeated and concurrent imports reuse the existing batch and never refresh original dates, replace values or restore an archived batch automatically.

**View saved evidence batches** opens current batches. Include archived batches to inspect history. Archive hides a batch from the current list while retaining every observation; Restore returns it. Both actions append a lifecycle event and use a revision check to reject stale-page changes. No destructive delete is exposed. The list shows the latest 100 matching batches and supports exact input/resolved-MPN filtering.

If the evidence tables are missing, batch pages show a database-update message, while the existing MPNs and import workflows remain available. Apply the final migration before enabling evidence saves. Use a disposable migrated database for acceptance; production changes require separate authorization.

## Verification

`npm run verify` is the repository gate. Focused tests cover source precision, fractional/percent units, blank versus zero, separate raw/audited windows, mixed validity, contact details, workbook compatibility and source-byte preservation, exact identity and alias collisions, zero-write preview, conflicts, stale previews, atomic failure, same-file and concurrent retry, archive/restore revision history, migration catalog consistency, and unchanged planning outputs for a qualified donor part.

Real source workbooks and inventories must stay outside Git. Use disposable databases for actual 50-MPN acceptance and browser checks. Do not treat a successful local import as production integration.
