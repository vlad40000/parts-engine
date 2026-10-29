/**
 * Instructions and output schema for the card reader. The lists come from the same
 * vocabulary the printed intake form and the Fleet status options use.
 */
import { PART_ACTIONS } from "./reading";
import { CARD_SYMPTOMS, INTAKE_FIELDS, MOVE_CARD_MACHINES, NOTE_STATUSES, REPAIR_CARD_PART_LINES } from "./vocabulary";

const CONF = { type: "string", enum: ["high", "low"] };
const STATUS = {
  type: "object",
  properties: {
    checked: { type: "string", description: "A Fleet status written or marked for the machine, or empty." },
    phrases: { type: "array", items: { type: "string" } },
    confidence: CONF
  },
  required: ["checked", "phrases", "confidence"]
};
const LOCATION = {
  type: "object",
  properties: {
    name: { type: "string", description: "A known location name, or empty." },
    text: { type: "string", description: "Location words exactly as written, or empty." },
    confidence: CONF
  },
  required: ["name", "text", "confidence"]
};
const PART = {
  type: "object",
  properties: {
    mpn: { type: "string" },
    name: { type: "string" },
    action: { type: "string", enum: [...PART_ACTIONS] },
    otherMachine: { type: "string" },
    condition: { type: "string", description: "bad or missing only when written; otherwise empty" },
    confidence: CONF
  },
  required: ["mpn", "name", "action", "otherMachine", "condition", "confidence"]
};
const ENTRY = {
  type: "object",
  properties: {
    machine: {
      type: "object",
      properties: { text: { type: "string" }, confidence: CONF, alternatives: { type: "array", items: { type: "string" } } },
      required: ["text", "confidence", "alternatives"]
    },
    model: { type: "string" },
    serial: { type: "string" },
    status: STATUS,
    location: LOCATION,
    readyForClean: { type: "boolean" },
    grade: { type: "string", description: "A, B, C or D when marked, else empty." },
    price: { type: "object", properties: { text: { type: "string" }, confidence: CONF }, required: ["text", "confidence"] },
    symptoms: { type: "array", items: { type: "string" } },
    problem: { type: "string" },
    workDone: { type: "string" },
    parts: { type: "array", items: PART },
    note: { type: "string" },
    struck: { type: "array", items: { type: "string" } }
  },
  required: ["machine", "model", "serial", "status", "location", "readyForClean", "grade", "price", "symptoms", "problem", "workDone", "parts", "note", "struck"]
};

export const READING_JSON_SCHEMA = {
  type: "object",
  properties: {
    card: { type: "string", enum: ["RR-F1", "RR-M1", "RR-R1", "free"] },
    date: { type: "object", properties: { text: { type: "string" }, confidence: CONF }, required: ["text", "confidence"] },
    tech: { type: "string" },
    entries: { type: "array", items: ENTRY },
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          status: STATUS,
          location: LOCATION,
          appliesTo: { type: "array", items: { type: "integer" } },
          confidence: CONF
        },
        required: ["text", "status", "location", "appliesTo", "confidence"]
      }
    },
    unreadable: { type: "array", items: { type: "string" } }
  },
  required: ["card", "date", "tech", "entries", "groups", "unreadable"]
} as const;

export function readerPrompt({ locations }: { locations: string[] }): string {
  const statuses = NOTE_STATUSES.map((s) => s.status).join(", ");
  const symptoms = CARD_SYMPTOMS.map((s) => `${s.key} ("${s.label}")`).join(", ");
  const known = locations.length ? locations.map((l) => `"${l}"`).join(", ") : "(none recorded yet)";
  return `You are reading a handwritten tech note from Road Runner Appliance, a used-appliance shop. Techs write these notes to update machines in the shop's inventory: the machine's status, where it is, what is wrong with it, and parts.

The photo shows one of:
- Form RR-F1, the Roadrunner Standardized Field Intake (half sheet, the current form): ONE machine. The approved form is headed "ROADRUNNER APPLIANCE" and "MACHINE SERVICE UPDATE" and does not need a printed RR-F1 code. Printed labels: ${INTAKE_FIELDS.join(", ")}, each followed by open writing space. Older copies may say "Status" instead of "Current status". Return one entry for the completed half sheet. The printed "1 OF 2" / "2 OF 2" are form positions, never machine numbers. Everything written under Notes (Problems / Parts needed / Work performed / Testing, plus other remarks) goes into problem, parts, workDone and note. Ignore the printed labels and blank writing lines.
- Card RR-M1, the old Status/Move card (quarter sheet): up to ${MOVE_CARD_MACHINES} machine numbers written one digit per box, which all share ONE status and ONE location; date; tech initials; optional grade and price; a note line. Return one entry per filled machine number and give each the card's status and location.
- Card RR-R1, the old Repair card (half sheet): one machine number; date; tech initials; model number (optional, for checking); status; location; symptom boxes; up to ${REPAIR_CARD_PART_LINES} part lines (Replaced / Needed / Taken out, part number one character per box, part name, a machine number, Bad or Missing); grade; price; notes.
- free: any other handwritten note, for example a legal pad. Machine numbers are written at the left margin and are usually 3 to 5 digits.

Reply with JSON only, matching the schema. Rules:
1. Copy what is written. Never invent characters. Read look-alikes carefully (1/7, 4/9, 5/6, 3/8, 0/6, O/0, I/1, S/5, B/8, Z/2). When a character is unclear, give your best reading, set that field's confidence to "low", and for machine numbers list the other plausible readings in "alternatives" (for example ["6611"] when "611" may have a first digit cut off at the page edge).
2. Crossed-out text is not current. Copy it into "struck" only and leave it out of every other field. A check mark next to a line means that line was done.
3. Status: "checked" is a status only when the writing or marked box clearly names one of the shop's Fleet statuses: ${statuses}. Old cards print "Ready for sale" (READY TO SALE), "Parts machine" (PARTS ONLY) and "Scrap" (SCRAPPED). Anything else that describes the machine's state goes in "phrases" as written, with "checked" empty: for example "Being repaired", "Ready for clean", "ICU!". Never turn "Ready for clean" into READY TO SALE, and never choose a status from the location.
4. "readyForClean" is true when "Ready for clean" is marked or written and not crossed out. It is not a status.
5. Location: "name" is one of these known locations when the writing clearly names it: ${known}. Otherwise leave "name" empty. "text" is the location words exactly as written, for example "Red building", "Showroom floor", "Between warehouse & metal building". A date written next to a location (for example "Showroom floor 5-11-26") is not part of the location.
6. When one status or location line is written once for several machines listed above it, put it in "groups" with "appliesTo" set to the 0-based indexes of the entries it covers, and leave those fields empty in the entries. Set the group's confidence to "low" when it is not clear which machines the line covers.
7. Symptom boxes (old repair card): list the marked boxes using these keys: ${symptoms}. Otherwise leave "symptoms" empty and write the problem in "problem".
8. "problem" is what is wrong (not crossed out). "workDone" is repairs or checks that were done, including the written test result. "note" is anything else. In a refrigeration note, "needs gassing" is a refrigeration service need: keep the words in problem, never infer a failed compressor or a gas-burner fault, and do not invent a part number for it.
9. Parts: one item per part line or part mentioned. "mpn" is the part number exactly as written, keeping any WP prefix, or empty when only a name is written. "name" is the part name as written ("lid switch", "timer", "inner tub"). "action": replaced (a part was installed in this machine), needed (the note says this machine needs the part), taken (taken out of this machine, for example for another machine), suspected (the note says to check it or that it may be bad: "check", "possible", "maybe", "?"), mentioned (anything else). "otherMachine" is the machine number written with the part ("from #4261", "for #2143"), digits only. "condition" is bad only when the note says the part itself is bad, broken, burnt, shorted or failed, and missing only when it says the part is missing; otherwise leave it empty. "Needs timer" alone is needed with an empty condition.
10. "price": copy as written ("$350"). "grade": A, B, C or D only when marked.
11. "date": the date written on the note, for example "5/12/26", exactly as written; empty when none is written. "tech": the initials.
12. Privacy: never copy customer or staff names, phone numbers or addresses. Write [name] instead.
13. "unreadable": a short description of any writing you could not read at all.
14. If the photo is not a tech note, return an empty "entries" list.`;
}
