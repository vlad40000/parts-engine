# Parts Engine

Intake → age band → parts lists → eBay evidence → compatibility cross-reference → harvest decisions,
for Road Runner Appliance. One app with its own Neon database. It reads nothing from, and writes nothing to,
Ledger, EbayDecisions or Image Finder databases. Files move between them as CSV.

## The process

| Step | Page | What happens |
|---|---|---|
| 1 Intake | **Intake** | Import the inventory workbook or numbered intake sheets (.xlsx/.csv), or add one machine. Machine IDs and model text are kept exactly. Purchaser columns are never read (allow-list import). |
| 2 Age band | **Fleet** | Every serial is decoded to *all* its possible build years (App 1 rules, without the newest-year collapse). A machine belongs to every band any candidate year falls in. Bands set research order only, never exclusion. |
| 3 Parts lists | **Parts lists** | Select a donor status from the imported machine statuses before running up to 10 models; age band/type further narrow the queue. No status is preselected. UNCHECKED can be selected for inspection-first research. SOLD, SCRAPED and SCRAPPED never qualify. Each model is read once and reused by every machine of that model. HTML only: Encompass → AppliancePartsPros. No AI. |
| 4 Research queue | **MPNs → Research queue** | Unique MPNs ordered by donor machines. Skipped before research: fasteners/hardware/literature and compressors (always scrap). There is no price prefilter: v7 has no general minimum part price. **Export queue CSV** writes the shared research CSV that EbayDecisions also imports and exports. |
| 5 eBay evidence | **MPNs → Import market facts** | Import the completed shared research CSV as is, the older EbayDecisions export, the decision workbook (MPN Master), or a plain CSV. Or refresh stored facts from EbayDecisions, or type facts on an MPN page. |
| 6 Qualification | **MPNs → Qualified** | Roadrunner Store Economics v7 (below). Results: `QUALIFIED`, `NOT QUALIFIED`, `NEEDS DATA`, `SET RULE`. All numbers live in **Settings**. |
| 7 Compatibility | **MPN page** | Every machine on the lot that contains the part, across every model whose parts list includes it. Your parts lists are the fitment list — complete for what you own, not a sample. |
| 8 Teardown | **Teardown queue** | With blank thresholds, shows an unranked physical review worklist and CSV with no economic pull recommendation. Once both thresholds are set, qualified parts are ordered by modeled value / slot-day. No pull cap or stock target. Export the yard pick list. |
| 9 Harvest | **Machine page** | Mark each part pulled / failed / missing. Pulled parts stop counting on that machine. Parts in a family matching the machine's failure symptom show **test first** and never count toward its score. |
| 10 Sales memory | **MPNs → Import Roadrunner sales history** | Roadrunner's own realized sales by MPN (CSV contract in `docs/INTEGRATION_CONTRACTS.md`), kept apart from eBay market facts. Shown on the MPN page and on every machine whose model parts list contains the MPN. |

## Qualification: Store Economics v7

The current qualification model is `Roadrunner_Store_Economics_Oct_2026_7.xlsx`, implemented in `src/lib/economics.ts`.

- **There is no general minimum part price.** The floor is each part's break-even item price.
- **Sell-through is an exact-MPN research input.** It comes from a research import or manual entry (provenance `research` / `manual`) and is never derived from sold and active counts. Sold 90d and active listings are stored as separate facts.
- **Qualification is deliberately `SET RULE`** until the owner enters both thresholds in Settings: minimum 90-day sell-through % and minimum projected profit margin %. They ship blank, and no default is assumed.
- Once set, a part is `QUALIFIED` when all pass: sold ≥ 3 in 90 days (or a strategic exception approved on the MPN page, which waives only this gate); exact sell-through ≥ the minimum; price ≥ break-even; projected margin ≥ the minimum. Missing price, removal minutes, exact sell-through or sold count (without an exception) gives `NEEDS DATA`.
- Planning economics, per part: fees = (P + B)(1 + tax)·FVF + P·promo + order fee; contribution = P + B − fees − shipping label − pack & ship labor − packaging − removal labor − machine-type overhead; margin = contribution / (P + B). Buyer-paid shipping B is revenue (planned at the label estimate when unknown); the label is still a seller cost. Removal labor uses the $15/h operations rate; management labor is not charged per part.
- Modeled value / slot-day = (P − break-even) × exact sell-through / 90. An ordering metric, not a probability.
- **Physical harvestability and economic qualification are separate.** The MPN page's harvest candidates come from donor status, part state and failure symptom only. Enter an exact MPN on the MPNs page to list checked donors across all cached model parts lists; optionally include UNCHECKED alongside checked donors or inspect it alone as test first. Off-lot statuses are historical audit views. Export the selected table as CSV.

The old prototype settings (25% all-in fee, $20 cushion, $1 minimum profit, 20% sell-through, stock window) remain as database columns for compatibility but no longer drive any decision.

## Setup

```bash
npm install
cp .env.example .env.local        # set DATABASE_URL to a new Neon database
npm run db:migrate
npm run dev                        # http://localhost:3001
```

Local trial without Neon: `DATABASE_URL=pglite:./.pglite npm run db:migrate && DATABASE_URL=pglite:./.pglite npm run dev`.

`db:migrate` applies all pending migrations in one transaction. `npm run db:migrate -- --plan` lists them without writing. Production migrations follow the pinned procedure in `docs/MIGRATIONS.md`.

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
- **Whole-machine gate.** Parts-list runs require an explicit imported status, independent of the optional Settings donor preference. With that preference blank, MPN default donor counts and Teardown use PARTS ONLY, NEEDS PARTS and PARTS PROGRAM. UNCHECKED can be selected for a Parts-list run or MPN donor view, but is excluded from default donor counts and teardown. SOLD, SCRAPED and SCRAPPED are always excluded even if an older settings row contains them. A cached model parts list is retained when a machine leaves the lot; it does not make that machine an eligible donor. There is no automatic scrap queue yet.
