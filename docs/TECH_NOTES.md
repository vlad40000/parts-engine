# Tech notes

Techs record what they found and where a machine went on paper. **Tech notes** turns a photo of that paper into machine updates, and asks a person about anything it cannot settle on its own.

## Flow

1. **Photo.** On a phone, *Tech notes → Take photo*. The browser shrinks the photo (long edge 1600 px, JPEG) before upload. A photo the browser cannot shrink (for example HEIC on a desktop browser) is refused above 4 MB, because hosted functions such as Vercel's reject request bodies over 4.5 MB.
2. **Read.** Gemini reads the card into a structured reading: machine numbers, status, location, symptoms, part lines, crossed-out text, date. Crossed-out text is kept apart and never applied.
3. **Check and ask.** Deterministic code (`src/lib/tech-notes/plan.ts`, not the model) compares the reading with the machine records and asks only what it cannot settle:
   - a machine number that is hard to read, not in the fleet (one-slip suggestions such as 6612 → 6611), or recorded as sold or scrapped;
   - a written model or serial that does not match the record, or words that do not fit the appliance ("gassing" on a washer);
   - the same machine twice on one note;
   - a line written once for several machines ("ICU! between warehouse & metal building") when it is unclear which machines it covers;
   - two statuses, "Ready for clean" away from a showroom, a move that usually goes with a status change, or a machine still UNCHECKED that the note describes;
   - the grade when a machine goes up for sale without one;
   - location wording that is not on the location list (use an existing location and remember the wording, or add a new location);
   - a part number not in that model's cached parts list (near matches such as WP394889 → WP3948891), a part named without a number, or a part line's machine number that does not exist;
   - a price or date that is hard to read.
4. **Apply.** Nothing is written until every question is answered. Then, in one SQL statement: status (with `status_override`), condition, location, diagnosis, repair notes and sticker price; a status event and field events tied to the note; part states (needed → failed/missing, taken out → pulled, replaced from #N → pulled on #N); new locations and remembered wordings. If any machine changed after the page was opened, nothing is written and the answers are kept.

The fix-it form on the review page edits the reading itself, so a misread is corrected once and the questions update. A note can also be typed by hand (no photo); it goes through the same checks.

## Cards

*Tech notes → Printable cards* prints from the app's own lists, so a card and the reader always agree. Print on letter paper at 100% and cut on the dashed lines.

| Card | Size | Use |
|---|---|---|
| **RR-M1 Status / Move** | quarter sheet, 4 per page | up to 4 machine numbers that share one status and one location |
| **RR-R1 Repair** | half sheet, 2 per page | one machine: status, location, symptoms, up to 4 part lines (replaced / needed / taken out, part number, part name, machine #, bad / missing), grade, price |

One digit per box and check boxes read faster and need fewer questions than free-hand notes. Reprint after a location is added, so its box appears. Free-hand notes still work.

## Record of truth

Owner decision 2026-10-29: once a tech note sets status, condition, location, diagnosis, repair notes or sticker price, Parts Engine is the record for that field. A workbook re-import keeps it (`fleet_machines.local_fields`; status keeps using `status_override`) and still refreshes everything else. The machine page lists the fields set here and the change history with links to each note.

## Settings

| Variable | Default | |
|---|---|---|
| `GEMINI_API_KEY` | — | Turns the reader on. Without it, photos are kept and notes are typed. |
| `GEMINI_OCR_MODEL` | `gemini-3.1-flash-lite` | First read (owner OCR rule). |
| `GEMINI_OCR_CAREFUL_MODEL` | `gemini-3.5-flash` | *Re-read carefully*. |
| `GEMINI_OCR_THINKING_LEVEL` | `MEDIUM` | `MINIMAL`, `LOW`, `MEDIUM`, `HIGH` or `OFF`. |

The database needs migration `0006_tech_notes` (additive). Apply it with the procedure in `docs/MIGRATIONS.md`.

## Privacy

Photos are stored in this database as the record of each change. The cards have no customer fields and say so. The reader is told not to copy names, phone numbers or addresses, and phone numbers are stripped from every reading. Uploading the same photo twice opens the existing note, so one card cannot be applied twice.
