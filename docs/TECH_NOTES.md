# Tech notes

Techs record what they found and where a machine is on paper. **Tech notes** turns a photo of that paper into machine updates, and asks a person about anything it cannot settle on its own.

## Flow

1. **Photo.** On a phone, *Tech notes → Take photo*. The browser shrinks the photo (long edge 1600 px, JPEG) before upload. A photo the browser cannot shrink (for example HEIC on a desktop browser) is refused above 4 MB, because hosted functions such as Vercel's reject request bodies over 4.5 MB.
2. **Read.** Gemini reads the form or note into a structured reading: machine numbers, date, status, location, symptoms, part lines, crossed-out text. Crossed-out text is kept apart and never applied.
3. **Check and ask.** Deterministic code (`src/lib/tech-notes/plan.ts`, not the model) compares the reading with the machine records and asks only what it cannot settle:
   - the date, when none is written, it is hard to read, or it is after today (the upload date is offered, never assumed);
   - a machine number that is hard to read, not in the fleet (one-slip suggestions such as 6612 → 6611), or recorded as sold or scrapped;
   - a written model or serial that does not match the record, or words that do not fit the appliance ("gassing" on a washer);
   - the same machine twice on one note;
   - a line written once for several machines when it is unclear which machines it covers;
   - two statuses written, a status that takes a machine off the lot (SOLD, SCRAPPED), or a machine still UNCHECKED that the note describes;
   - the grade when a machine goes up for sale without one;
   - location wording that is not on the location list (use an existing location and remember the wording, or add a new location);
   - a part number not in that model's cached parts list (near matches such as WP394889 → WP3948891), a part named without a number, or a part line's machine number that does not exist;
   - whether the note or the record is newer, when the dates cannot settle it (see Chronology);
   - a price that is hard to read.
4. **Apply.** Nothing is written until every question is answered. Then, in one SQL statement: the applied changes, history rows dated by the note, part decisions, VERIFY LOCATION checks, `last_field_update_at`, new locations and remembered wordings, and the note with its written date. If any machine changed after the page was opened, nothing is written and the answers are kept.

The fix-it form on the review page edits the reading itself, so a misread is corrected once and the questions update. A note can also be typed by hand (no photo); it goes through the same checks.

## Statuses (owner rules 2026-10-29)

- A note sets only the **Fleet status options** (`src/lib/fleet-status.ts`): UNCHECKED, NEEDS PARTS, PARTS ONLY, PARTS PROGRAM, READY TO SALE, SOLD, SCRAPPED. The reader, the review form and the intake form all use that list.
- A status changes only when the note says one. A location never implies a status (no "showroom means for sale", no "ICU means needs parts").
- "Ready for clean" is not a status and never becomes READY TO SALE. It goes in the repair notes, as do other words that are not Fleet statuses ("Being repaired", the old card's box).
- Donor eligibility: a status that takes a machine off the lot is confirmed first; the review shows when a status change moves a machine into or out of the donor pool (Settings donor statuses). UNCHECKED machines become donors only through an explicit answer.

## Parts

Each part line is one decision:

| Written | Decision | Effect |
|---|---|---|
| "check", "maybe", "possible" | **suspected** | stays on pick lists; its family is marked test first |
| "needs X" | **needed** | stays on pick lists; its family is marked test first. Never failed just because it is needed |
| X written bad / broken / burnt | **failed** | off pick lists (`machine_part_state` failed): never pulled for sale |
| X written missing | **missing** | off pick lists |
| "replaced X from #N" | **replaced** | recorded on this machine; #N's part is **removed** if #N is on the lot and has the part |
| "took X for #N" | **removed** | off pick lists (`pulled`) |

Every decision is kept in `fleet_part_events`, applied or history only.

## Chronology

The date written on a note is when it was observed; the upload time is only when it reached the app. Both are shown.

- `fleet_machines.last_field_update_at` holds when the newest accepted decision on a machine was observed (a note's written date, or the time of a Fleet edit or location check). Migration 0007 backfills it from earlier Fleet status edits and part states.
- Each field (status, condition, location, diagnosis, sticker price) and each part also has its newest decision, from the event tables.
- A note **older** than a field's or part's newest decision does not change it. What it said is saved as history only (`applied = false`), and its dated line is still added to the repair notes, marked as older.
- When precedence is **uncertain**, the app asks: the note and the record were set on the same day, or the machine was updated after the note's date in another field.
- Repair notes are a log, not a decision: a note's dated line is always appended.

## VERIFY LOCATION

When a note records a location that differs from the machine's location on record, the note's location is applied (it is the newer observation) and a **VERIFY LOCATION** check opens (`fleet_location_checks`). Both locations stay in the history. Fleet shows the flag and a count; the machine page asks where the machine is. Only that physical check clears it; a Fleet location edit does not. Filling in an empty location, or a note older than the record, raises no check.

## Field intake form

*Tech notes → Field intake form* prints the **Roadrunner Standardized Field Intake (RR-F1)**: two half-sheet forms per letter page, one machine per form, solid black text and lines, open writing space for Machine #, Date, Location, Status and Notes. The Fleet status names are printed small under Status as a reference. Print at 100% (Actual size) and cut on the center line.

The reader still reads the old RR-M1 Status/Move and RR-R1 Repair cards and free handwritten notes; those cards are no longer printed.

## Record of truth

Owner decision 2026-10-29: once a tech note sets status, condition, location, diagnosis, repair notes or sticker price, Parts Engine is the record for that field. A workbook re-import keeps it (`local_fields` for condition, diagnosis, notes and sticker price; `status_override`; `location_override`, shared with the Fleet location editor from #31) and still refreshes everything else.

## Settings

| Variable | Default | |
|---|---|---|
| `GEMINI_API_KEY` | — | Turns the reader on. Without it, photos are kept and notes are typed. |
| `GEMINI_OCR_MODEL` | `gemini-3.1-flash-lite` | First read (owner OCR rule). |
| `GEMINI_OCR_CAREFUL_MODEL` | `gemini-3.5-flash` | *Re-read carefully*. |
| `GEMINI_OCR_THINKING_LEVEL` | `MEDIUM` | `MINIMAL`, `LOW`, `MEDIUM`, `HIGH` or `OFF`. |

## Migrations and order

This branch sits on #31. Apply in order, with the procedure in `docs/MIGRATIONS.md`:

1. `0006_fleet_location_edits` (#31): `location_override`.
2. `0007_tech_notes` (this work, additive): tech notes, location list, field/part/location-check history, `local_fields`, `sticker_price`, `last_field_update_at`, observation dates; backfills `last_field_update_at`.

Apply each migration before deploying code that uses it.

## Real-photo trial

`test/ocr-trial.local.test.ts` reads a folder of photos with the configured reader and prints what it read, for comparison by eye. It runs only with `GEMINI_API_KEY` and `OCR_TRIAL_DIR` set, and photos stay outside the repo:

```
GEMINI_API_KEY=… OCR_TRIAL_DIR=/path/to/photos OCR_TRIAL_OUT=trial.json npx vitest run test/ocr-trial.local.test.ts
```

## Privacy

Photos are stored in this database as the record of each change. The form has no customer fields and says so. The reader is told not to copy names, phone numbers or addresses, and phone numbers are stripped from every reading. Uploading the same photo twice opens the existing note, so one form cannot be applied twice.
