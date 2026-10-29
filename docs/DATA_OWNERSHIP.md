# Data Ownership and Provenance

Parts Engine uses its own database. Cross-application integration is through explicit contracts/APIs or file fallback, never cross-database foreign keys.

| Data | Authority | Parts Engine role |
|---|---|---|
| Machine identity / fleet intake | Appliance Inventory / App 1 when connected | Operational imported snapshot |
| Machine physical location | Fleet import, Fleet UI manual override, or tech note | Operational location per machine ID; a manual or note-set location survives subsequent imports (`location_override`) |
| Machine operational state set from tech notes (status, condition, diagnosis, repair notes, sticker price) | Parts Engine (owner decision 2026-10-29) | Record of truth once set here; a workbook re-import fills only fields not set here (`local_fields`, `status_override`) |
| Location list and its learned wordings | Parts Engine | Seeded from imported locations; tech notes add locations and aliases |
| Serial age candidates | Evidence-qualified resolver / imported machine record | Preserve candidates, confidence and reason |
| Supplier model BOM | Parts Engine supplier research | Authoritative for the captured supplier observation |
| eBay sold/active/price research | EbayDecisions | Cache with source + captured timestamp |
| MPN replacement/equivalence research | Parts Image Finder | Cache relationship edges |
| External MPN-to-model fitment | Parts Image Finder | Cache separate fitment edges with completeness/provenance |
| Physical harvested stock and loose-part bin locations | Roadrunner Parts Ledger | Consume stock facts; do not treat a donor machine location as a harvested part's bin |
| SKU/listing/publish lifecycle | Roadrunner Parts Ledger | Downstream consumer / feedback |
| Realized sale outcomes | Roadrunner Parts Ledger/eBay sync | Feedback/calibration input |
| Harvest planning state | Parts Engine | Authoritative planning state |

## Inventory quantities
Keep three concepts distinct:

- **Physical stock:** already harvested and available as inventory.
- **Recoverable stock:** compatible parts still installed in donor machines.
- **Reserve donor stock:** recoverable units intentionally left in machines until demand warrants a pull.

Do not add recoverable donor count to physical on-hand quantity.

## Privacy
Fleet imports are allow-listed. Purchaser name, address, phone, email, payment, or other customer PII must not enter Parts Engine data, fixtures, logs, exports, or Git history.

Tech-note photos are stored in this database because they are the record of each change. The printed cards carry no customer fields and say so; the card reader is told not to copy names, phone numbers or addresses, and phone numbers are stripped from every reading.

## Provenance
Imported/cached facts should retain enough information to answer:
- which system/source supplied this value,
- when it was captured,
- whether it was observed or derived,
- whether a compatibility set is complete or only sampled/partial.

Unknown must remain unknown rather than being replaced with a precise-looking fallback.
