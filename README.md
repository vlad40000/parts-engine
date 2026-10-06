# Parts Engine

Intake → age band → parts lists → eBay evidence → compatibility cross-reference → harvest decisions,
for Road Runner Appliance. One app with its own Neon database. It reads nothing from, and writes nothing to,
Ledger, EbayDecisions or Image Finder databases. Files move between them as CSV.

## The process

| Step | Page | What happens |
|---|---|---|
| 1 Intake | **Intake** | Import the inventory workbook or numbered intake sheets (.xlsx/.csv), or add one machine. Machine IDs and model text are kept exactly. Purchaser columns are never read (allow-list import). |
| 2 Age band | **Fleet** | Every serial is decoded to *all* its possible build years (App 1 rules, without the newest-year collapse). A machine belongs to every band any candidate year falls in. Bands set research order only, never exclusion. |
| 3 Parts lists | **Parts lists** | Choose a band/type, select up to 10 models (most machines first) and run. Each model is read once and reused by every machine of that model. HTML only: Encompass → AppliancePartsPros. No AI. |
| 4 Research queue | **MPNs → Research queue** | Unique MPNs ordered by donor machines. Skipped before research: fasteners/hardware/literature, compressors (always scrap), and parts whose new OEM price is below the lowest price that could greenlight. **Export queue CSV** imports straight into EbayDecisions. |
| 5 eBay evidence | **MPNs → Import market facts** | Import the EbayDecisions export, the decision workbook (MPN Master), or a plain CSV. Or type facts on an MPN page. |
| 6 Verdict | **MPNs → List these** | Greenlight = sell-through ≥ 20% **and** `P − F − S − L − $20 ≥ $1` (harvested). F = 25% of P (+B unless free shipping). L = removal minutes × $15/60. Ranked by profit × daily demand × share. All numbers live in **Settings**. |
| 7 Compatibility | **MPN page** | Every machine on the lot that contains the part, across every model whose parts list includes it. Your parts lists are the fitment list — complete for what you own, not a sample. |
| 8 Teardown | **Teardown queue** | Machines ranked by profit of greenlit parts still inside, capped at ~30 days of demand minus stock on hand. Export the yard pick list. |
| 9 Harvest | **Machine page** | Mark each part pulled / failed / missing. Pulled parts stop counting on that machine. Parts in a family matching the machine's failure symptom show **test first** and never count toward its score. |

## Setup

```bash
npm install
cp .env.example .env.local        # set DATABASE_URL to a new Neon database
npm run db:migrate
npm run dev                        # http://localhost:3001
```

Local trial without Neon: `DATABASE_URL=pglite:./.pglite npm run db:migrate && DATABASE_URL=pglite:./.pglite npm run dev`.

Verify: `npm run verify` (typecheck → tests → build).

## Suppliers

| Supplier | Status | Notes |
|---|---|---|
| Encompass PartStore | wired, first | Whole model on one page, OEM numbers direct. Brand prefix map from Ledger. Samsung/LG slash models use `BASE%7CSUFFIX/0001/`. Frigidaire model pages showed no parts list in HTML on 2026-10-06 → falls through. |
| AppliancePartsPros | wired, second | Model page → every section page. OEM read from the part link; rows with no readable OEM are dropped and counted, never stored under the AP id. |
| PartSelect, PartsDr | not wired | Serve static HTML (checked 2026-10-06). Capture fixtures first: `npm run capture -- partselect <model url>`, then write the parser against them. |
| Reliable Parts, PartAdvantage | blocked | 403. |
| Sears PartsDirect | blocked | JavaScript-only. |

Requests are rate-limited per supplier host (2 at once, 600 ms apart).

## Known gaps

- **Removal minutes.** Washer, dryer, range and refrigerator baselines come from the Removal Time Library. Dishwasher and microwave have component names but no minutes. Fill them in Settings; until then those parts answer NEEDS DATA.
- **Ages.** The serial rules are ported from the App 1 documentation, not its source. Model production windows and Wayback evidence are not yet used to eliminate candidate years.
- **Stock on hand** comes from the market import or the MPN page (`qty_on_hand`). It is not yet read live from Ledger.
- **Supersessions.** WP prefixes are aliased automatically. Other replaced numbers are added by hand on the MPN page until a supplier parser captures "replaces" lists.
- **Whole-machine gate.** Non-donor statuses (READY TO SALE, BEING REPAIRED, …) are excluded via Settings → donor statuses. There is no automatic scrap queue yet.
