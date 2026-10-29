/**
 * Instructions and output schema for the card reader. The lists come from the same
 * vocabulary the printed cards use.
 */
import { CARD_STATUSES, CARD_SYMPTOMS, MOVE_CARD_MACHINES, REPAIR_CARD_PART_LINES } from "./vocabulary";

const CONF = { type: "string", enum: ["high", "low"] };
const STATUS = {
  type: "object",
  properties: {
    checked: { type: "string", description: "Marked status box on a printed card, or empty." },
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
    action: { type: "string", enum: ["replaced", "needed", "taken", "mentioned"] },
    otherMachine: { type: "string" },
    condition: { type: "string", description: "bad, missing, or empty" },
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
    card: { type: "string", enum: ["RR-M1", "RR-R1", "free"] },
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
  const statuses = CARD_STATUSES.map((s) => `${s.status} ("${s.label}")`).join(", ");
  const symptoms = CARD_SYMPTOMS.map((s) => `${s.key} ("${s.label}")`).join(", ");
  const known = locations.length ? locations.map((l) => `"${l}"`).join(", ") : "(none recorded yet)";
  return `You are reading a handwritten tech note from Road Runner Appliance, a used-appliance shop. Techs write these notes to update machines in the shop's inventory: the machine's status, where it is, what is wrong with it, and parts.

The photo shows one of:
- Card RR-M1, the Status/Move card (quarter sheet): up to ${MOVE_CARD_MACHINES} machine numbers written one digit per box, which all share ONE status and ONE location; date; tech initials; optional grade and price; a note line. Return one entry per filled machine number and give each the card's status and location.
- Card RR-R1, the Repair card (half sheet): one machine number; date; tech initials; model number (optional, for checking); status; location; symptom boxes; up to ${REPAIR_CARD_PART_LINES} part lines (Replaced / Needed / Taken out, part number one character per box, a machine number, bad or missing); grade; price; notes.
- free: any other handwritten note, for example a legal pad. Machine numbers are written at the left margin and are usually 3 to 5 digits.

Reply with JSON only, matching the schema. Rules:
1. Copy what is written. Never invent characters. Read look-alikes carefully (1/7, 4/9, 5/6, 3/8, 0/6, O/0, I/1, S/5, B/8, Z/2). When a character is unclear, give your best reading, set that field's confidence to "low", and for machine numbers list the other plausible readings in "alternatives" (for example ["6611"] when "611" may have a first digit cut off at the page edge).
2. Crossed-out text is not current. Copy it into "struck" only and leave it out of every other field. A check mark next to a line means that line was done.
3. Status: on a printed card, "checked" is the marked status box, exactly one of: ${statuses}. On a free note leave "checked" empty and copy the status words into "phrases", for example "Ready for clean", "Ready for $ale", "ICU!", "Parts machine", "Needs parts".
4. "readyForClean" is true when "Ready for clean" is marked or written and not crossed out.
5. Location: "name" is one of these known locations when the card marks it or the words clearly name it: ${known}. Otherwise leave "name" empty. "text" is the location words exactly as written, for example "Red building", "Showroom floor", "Between warehouse & metal building". A date written next to a location (for example "Showroom floor 5-11-26") is not part of the location.
6. When one status or location line is written once for several machines listed above it, put it in "groups" with "appliesTo" set to the 0-based indexes of the entries it covers, and leave those fields empty in the entries. Set the group's confidence to "low" when it is not clear which machines the line covers.
7. Symptom boxes (repair card): list the marked boxes using these keys: ${symptoms}. On a free note leave "symptoms" empty and write the problem in "problem".
8. "problem" is what is wrong (not crossed out). "workDone" is repairs or checks that were done. "note" is anything else.
9. Parts: one item per part line or part mentioned. "mpn" is the part number exactly as written, keeping any WP prefix, or empty when only a name is written. "name" is the part name as written ("lid switch", "timer", "inner tub"). "action": replaced (installed in this machine), needed (this machine needs it because it is bad or missing), taken (taken out of this machine for another machine), mentioned (anything else). "otherMachine" is the machine number written with the part ("from #4261", "for #2143"), digits only. "condition" for needed parts is bad, missing, or empty when not said.
10. "price": copy as written ("$350"). "grade": A, B, C or D only when marked.
11. "date": the note's date as written, for example "5/12/26". "tech": the initials.
12. Privacy: never copy customer or staff names, phone numbers or addresses. Write [name] instead.
13. "unreadable": a short description of any writing you could not read at all.
14. If the photo is not a tech note, return an empty "entries" list.`;
}
