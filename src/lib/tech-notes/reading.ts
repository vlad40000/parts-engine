/**
 * A tech-note reading: what the card says, before any lookup against the fleet.
 * The card reader (Gemini) and the review form both produce this shape; the planner turns it
 * into questions and changes. Everything here is plain data so it can cross to the browser.
 */
import { CARD_STATUS_VALUES, SYMPTOM_KEYS, isCardCode, type CardCode } from "./vocabulary";

export type Confidence = "high" | "low";
export const PART_ACTIONS = ["replaced", "needed", "taken", "mentioned"] as const;
export type PartAction = (typeof PART_ACTIONS)[number];
export const PART_CONDITIONS = ["bad", "missing", ""] as const;
export type PartCondition = (typeof PART_CONDITIONS)[number];

export type ReadPart = {
  /** Stable key within its entry, so answers survive edits to other lines. */
  key: string;
  /** Part number exactly as written (WP prefix kept), "" when only a name is written. */
  mpn: string;
  /** Part name as written ("timer", "pressure sensor"). */
  name: string;
  action: PartAction;
  /** Machine number on the line: "from #" for replaced, "for #" for taken. */
  otherMachine: string;
  /** For needed parts: bad (failed) or missing. */
  condition: PartCondition;
  confidence: Confidence;
};
export type ReadStatus = { checked: string; phrases: string[]; confidence: Confidence };
export type ReadLocation = { name: string; text: string; confidence: Confidence };
export type ReadEntry = {
  /** Stable key within the note, so answers survive edits to other entries. */
  key: string;
  machine: { text: string; confidence: Confidence; alternatives: string[] };
  model: string;
  serial: string;
  status: ReadStatus;
  location: ReadLocation;
  readyForClean: boolean;
  grade: string;
  price: { text: string; confidence: Confidence };
  symptoms: string[];
  problem: string;
  workDone: string;
  parts: ReadPart[];
  note: string;
  struck: string[];
};
/**
 * A status/location line written once for several machines ("ICU! between warehouse & metal building").
 * appliesTo holds entry keys (the reader returns entry indexes; normalizeReading converts them).
 */
export type ReadGroup = { key: string; text: string; status: ReadStatus; location: ReadLocation; appliesTo: string[]; confidence: Confidence };
export type NoteReading = {
  card: CardCode;
  date: { text: string; confidence: Confidence };
  tech: string;
  entries: ReadEntry[];
  groups: ReadGroup[];
  unreadable: string[];
};

export const MAX_ENTRIES = 12;
export const MAX_PARTS = 12;

let keySeq = 0;
/** A key unlikely to collide with e0, e1… or another new line in the same session. */
export const newKey = (prefix: string) => `${prefix}${Date.now().toString(36)}${(keySeq++).toString(36)}`;

export function emptyEntry(key = newKey("e")): ReadEntry {
  return {
    key,
    machine: { text: "", confidence: "high", alternatives: [] },
    model: "", serial: "",
    status: { checked: "", phrases: [], confidence: "high" },
    location: { name: "", text: "", confidence: "high" },
    readyForClean: false,
    grade: "",
    price: { text: "", confidence: "high" },
    symptoms: [], problem: "", workDone: "", parts: [], note: "", struck: []
  };
}

export function emptyPart(key = newKey("p")): ReadPart {
  return { key, mpn: "", name: "", action: "needed", otherMachine: "", condition: "", confidence: "high" };
}

export function emptyReading(card: CardCode = "free"): NoteReading {
  return { card, date: { text: "", confidence: "high" }, tech: "", entries: [emptyEntry("e0")], groups: [], unreadable: [] };
}

// ---------------------------------------------------------------------------
// Normalization: never trust the model's JSON (or a posted form) to match the type.
// ---------------------------------------------------------------------------
const PHONE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Free text: trimmed, single-spaced, phone numbers removed (cards must not carry customer contacts). */
export function cleanText(v: unknown, max = 300): string {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(PHONE, "[phone]").replace(/\s+/g, " ").trim().slice(0, max);
}
/** Identifiers (machine #, MPN, model, serial): characters kept as written, no redaction. */
function cleanCode(v: unknown, max = 40): string {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
const confidence = (v: unknown): Confidence => (v === "low" ? "low" : "high");
const texts = (v: unknown, max: number, len = 160) => arr(v).map((x) => cleanText(x, len)).filter(Boolean).slice(0, max);

function status(v: unknown): ReadStatus {
  const o = obj(v);
  const checked = cleanCode(o.checked, 30).toUpperCase();
  return { checked: CARD_STATUS_VALUES.includes(checked) ? checked : "", phrases: texts(o.phrases, 8, 80), confidence: confidence(o.confidence) };
}
function location(v: unknown): ReadLocation {
  const o = obj(v);
  return { name: cleanText(o.name, 60), text: cleanText(o.text, 120), confidence: confidence(o.confidence) };
}
const KEY = /^[a-z][a-z0-9]{0,24}$/;
/** Keep a valid, unique key or assign `${prefix}${index}`. */
function keyed<T extends { key: string }>(items: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return items.map((item, i) => {
    let key = KEY.test(item.key) && !seen.has(item.key) ? item.key : `${prefix}${i}`;
    while (seen.has(key)) key = `${key}x`;
    seen.add(key);
    return { ...item, key };
  });
}

function part(v: unknown): ReadPart {
  const o = obj(v);
  const action = PART_ACTIONS.includes(o.action as PartAction) ? o.action as PartAction : "mentioned";
  const condition = PART_CONDITIONS.includes(o.condition as PartCondition) ? o.condition as PartCondition : "";
  return {
    key: typeof o.key === "string" ? o.key : "",
    mpn: cleanCode(o.mpn, 40), name: cleanText(o.name, 60), action,
    otherMachine: cleanCode(o.otherMachine, 20).replace(/\D/g, ""), condition, confidence: confidence(o.confidence)
  };
}
function entry(v: unknown): ReadEntry {
  const o = obj(v);
  const m = obj(o.machine);
  const grade = cleanCode(o.grade, 1).toUpperCase();
  return {
    key: typeof o.key === "string" ? o.key : "",
    machine: {
      text: cleanCode(m.text, 20),
      confidence: confidence(m.confidence),
      alternatives: arr(m.alternatives).map((x) => cleanCode(x, 20).replace(/\D/g, "")).filter(Boolean).slice(0, 4)
    },
    model: cleanCode(o.model, 40),
    serial: cleanCode(o.serial, 40),
    status: status(o.status),
    location: location(o.location),
    readyForClean: o.readyForClean === true,
    grade: ["A", "B", "C", "D"].includes(grade) ? grade : "",
    price: { text: cleanText(obj(o.price).text, 20), confidence: confidence(obj(o.price).confidence) },
    symptoms: [...new Set(arr(o.symptoms).map((x) => String(x)).filter((x) => SYMPTOM_KEYS.includes(x)))],
    problem: cleanText(o.problem, 400),
    workDone: cleanText(o.workDone, 400),
    parts: keyed(arr(o.parts).map(part).filter((p) => p.mpn || p.name).slice(0, MAX_PARTS), "p"),
    note: cleanText(o.note, 400),
    struck: texts(o.struck, 12)
  };
}

export function normalizeReading(raw: unknown): NoteReading {
  const o = obj(raw);
  const entries = keyed(arr(o.entries).map(entry).slice(0, MAX_ENTRIES), "e");
  const entryKeys = new Set(entries.map((e) => e.key));
  const groups = keyed(arr(o.groups).map((g) => {
    const x = obj(g);
    const appliesTo = [...new Set(arr(x.appliesTo).map((a) =>
      typeof a === "number" ? entries[a]?.key : typeof a === "string" && entryKeys.has(a) ? a : undefined
    ).filter((k): k is string => Boolean(k)))];
    return {
      key: typeof x.key === "string" ? x.key : "",
      text: cleanText(x.text, 160), status: status(x.status), location: location(x.location), appliesTo, confidence: confidence(x.confidence)
    };
  }).filter((g) => g.appliesTo.length && (g.status.checked || g.status.phrases.length || g.location.name || g.location.text)).slice(0, 6), "g");
  const card = cleanCode(o.card, 10);
  const date = obj(o.date);
  return {
    card: isCardCode(card) ? card : "free",
    date: { text: cleanText(date.text, 20), confidence: confidence(date.confidence) },
    tech: cleanText(o.tech, 6),
    entries: entries.length ? entries : [emptyEntry("e0")],
    groups,
    unreadable: texts(o.unreadable, 10)
  };
}

/** Machine number as digits only ("#6146" → "6146"). */
export const machineDigits = (text: string) => text.replace(/\D/g, "");
