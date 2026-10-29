/**
 * Turns a tech-note reading into (a) the questions a person must answer and (b) the exact
 * changes that will be written. Pure and deterministic: the review page runs it live in the
 * browser, and the server runs it again on apply with fresh facts before writing anything.
 *
 * It never guesses. Anything the reading and the machine record cannot settle on their own
 * becomes a question, and nothing is ready to apply until every question has an answer.
 *
 * Rules the owner set (2026-10-29):
 * - A note sets only Fleet statuses, and only when it says one. Location never implies a status;
 *   "Ready for clean" never becomes READY TO SALE.
 * - "Needs X" is not "X failed". Only a part written as bad is failed; suspected and needed parts
 *   stay on pick lists marked test first.
 * - The date written on a note is when it was observed. An older note never reverses a newer
 *   decision: its values are kept as history. When the dates cannot settle it, ask.
 * - A recorded location that differs from the location on record raises VERIFY LOCATION.
 */
import { canonicalizeMpn } from "@/src/lib/mpn";
import { modelKey } from "@/src/lib/model-key";
import { classifyFamily } from "@/src/lib/part-family";
import {
  CONDITION_FOR_STATUS, CARD_SYMPTOMS, NOTE_STATUS_VALUES, OFF_LOT_STATUSES, SALE_GRADES,
  gradeCondition, isNoteStatus, isSaleCondition, normalizeLocation, parseCardDate, shortDate, statusLabel, titleCaseLocation
} from "./vocabulary";
import { machineDigits, type NoteReading, type ReadEntry, type ReadGroup, type ReadLocation, type ReadPart } from "./reading";

// ---------------------------------------------------------------------------
// Facts: the fleet records the planner may consult.
// ---------------------------------------------------------------------------
export type BomPart = { mpn: string; display: string; description: string; family: string };
/** When a decision was observed: the shop day (YYYY-MM-DD) and how to show it. */
export type Observed = { day: string; label: string };
/** Fields whose newest decision an older note must not reverse. Repair notes are a log, not a decision. */
export type TrackedField = "availability" | "condition" | "location" | "diagnosis" | "stickerPrice";
export type MachineFact = {
  machineNo: string;
  availability: string;
  condition: string | null;
  location: string | null;
  diagnosis: string | null;
  notes: string | null;
  applianceType: string;
  brand: string;
  modelRaw: string;
  serial: string;
  stickerPrice: string | null;
  /** updated_at as Postgres text: the optimistic-concurrency token checked on apply. */
  version: string;
  bomStatus: string | null;
  bomParts: BomPart[];
  /** Newest accepted decision on the machine (last_field_update_at, or any field or part decision). */
  lastUpdate: Observed | null;
  /** Newest accepted decision per field. */
  fieldUpdates: Partial<Record<TrackedField, Observed>>;
  /**
   * Newest accepted decision per part (canonical MPN), with its availability state if any and the
   * part record's updated_at as Postgres text: apply refuses to write over a part record changed since.
   */
  partUpdates: Record<string, Observed & { state: string | null; token?: string | null }>;
  /** A VERIFY LOCATION check is already open. */
  openLocationCheck: boolean;
};
export type LocationFact = { name: string; aliases: string[] };
export type PlanFacts = {
  machines: Record<string, MachineFact>;
  locations: LocationFact[];
  /** Shop calendar day, YYYY-MM-DD. */
  today: string;
  /** Shop day the note was uploaded (offered when no date is written). */
  uploadedOn: string;
  /** Statuses whose machines are parts donors (Settings). */
  donorStatuses: string[];
};
/** Question id → chosen option value ("use:6146", "set:READY TO SALE", "keep", "text:…", "e0,e2"). */
export type Answers = Record<string, string>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
export type FieldName = TrackedField | "notes";
export type FieldChange = { field: FieldName; from: string | null; to: string | null };
export const PART_KINDS = ["suspected", "needed", "failed", "missing", "replaced", "removed"] as const;
export type PartKind = (typeof PART_KINDS)[number];
export const PART_KIND_LABEL: Record<PartKind, string> = {
  suspected: "suspected (test first)", needed: "needed (test first)", failed: "failed", missing: "missing", replaced: "replaced", removed: "removed"
};
/** What a part decision does to availability on pick lists (machine_part_state). */
const STATE_FOR_KIND: Partial<Record<PartKind, "failed" | "missing" | "pulled">> = { failed: "failed", missing: "missing", removed: "pulled" };
export type PartDecision = {
  machineNo: string;
  /** Canonical MPN from the parts list, or null when the note names a part that is not matched. */
  mpn: string | null;
  mpnDisplay: string;
  name: string;
  kind: PartKind;
  otherMachine: string | null;
  /** False: an older note; kept as history only. */
  applied: boolean;
  /** Part family flagged test first (suspected or needed). */
  testFirst: string | null;
  note: string;
};
export type PartStateChange = {
  machineNo: string; mpn: string; mpnDisplay: string; state: "pulled" | "failed" | "missing"; note: string;
  /** The part record this plan was built on (updated_at as Postgres text), or null when there was none. */
  seenToken: string | null;
};
export type LocationCheck = { from: string; to: string };
export type QuestionKind = "date" | "machine" | "duplicate" | "group" | "status" | "grade" | "location" | "part" | "other_machine" | "price" | "order";
export type QuestionOption = { value: string; label: string; detail?: string; recommended?: boolean };
export type Question = {
  id: string;
  kind: QuestionKind;
  /** Entry key the question belongs to, or null for note-wide questions. */
  entry: string | null;
  prompt: string;
  options: QuestionOption[];
  /** Free answer, posted as "text:<value>". */
  allowText?: { label: string; placeholder?: string };
  /** Several options may be chosen; the answer is the comma-joined values (may be empty). */
  multi?: boolean;
  answer: string | null;
  /** Why the current answer cannot be used (for example a typed machine number that does not exist). */
  error?: string;
};
export type PlannedEntry = {
  key: string;
  label: string;
  machineNo: string | null;
  skipped: boolean;
  fact: MachineFact | null;
  /** Written to the machine. */
  changes: FieldChange[];
  /** What the note said that an older date keeps out of the record: history only. */
  history: FieldChange[];
  parts: PartDecision[];
  /** Availability states written to machine_part_state (applied failed, missing, removed). */
  partStates: PartStateChange[];
  /** Part families flagged test first. */
  testFirst: string[];
  /** VERIFY LOCATION raised by this note. */
  locationCheck: LocationCheck | null;
  struck: string[];
  info: string[];
};
export type Plan = {
  /** Observation date written on the note (YYYY-MM-DD), once settled. */
  date: string | null;
  uploadedOn: string;
  entries: PlannedEntry[];
  questions: Question[];
  locationsToAdd: Array<{ name: string; aliases: string[] }>;
  aliasesToAdd: Array<{ name: string; alias: string }>;
  unanswered: number;
  hasChanges: boolean;
  ready: boolean;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Machine numbers one handwriting slip away, most likely first: one digit misread,
 * two digits swapped, one digit dropped, one digit added.
 */
export function nearMachineNumbers(no: string): string[] {
  const out: string[] = [];
  const d = "0123456789";
  for (let i = 0; i < no.length; i += 1) for (const c of d) out.push(no.slice(0, i) + c + no.slice(i + 1));
  for (let i = 0; i + 1 < no.length; i += 1) out.push(no.slice(0, i) + no[i + 1] + no[i] + no.slice(i + 2));
  for (let i = 0; i < no.length; i += 1) out.push(no.slice(0, i) + no.slice(i + 1));
  for (let i = 0; i <= no.length; i += 1) for (const c of d) out.push(no.slice(0, i) + c + no.slice(i));
  return [...new Set(out)].filter((x) => x && x !== no && !x.startsWith("0"));
}

/** Every machine number the reading or the answers point at (for loading facts). */
export function referencedMachineNumbers(reading: NoteReading, answers: Answers): string[] {
  const out = new Set<string>();
  for (const e of reading.entries) {
    const raw = machineDigits(e.machine.text);
    if (raw) out.add(raw);
    e.machine.alternatives.forEach((a) => out.add(a));
    for (const p of e.parts) if (p.otherMachine) out.add(p.otherMachine);
  }
  for (const [id, a] of Object.entries(answers)) {
    if (!/^(machine|other):/.test(id)) continue;
    const no = a.startsWith("use:") ? a.slice(4) : a.startsWith("text:") ? machineDigits(a.slice(5)) : "";
    if (no) out.add(no);
  }
  return [...out].filter((n) => /^\d{1,7}$/.test(n));
}

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const cap = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
};
const money = (text: string): string | null => {
  const m = /(\d{1,5})(?:[.,](\d{1,2}))?/.exec(text.replace(/,(?=\d{3}\b)/g, ""));
  if (!m) return null;
  const n = Number(`${m[1]}.${(m[2] ?? "0").padEnd(2, "0")}`);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
};
const sameMoney = (a: string | null, b: string | null) => (a == null || b == null ? a === b : Number(a) === Number(b));
const normSerial = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const modelsAgree = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a) || levenshtein(a, b) <= 1;
const isOffLot = (status: string) => OFF_LOT_STATUSES.includes(status.trim().toUpperCase());
export const machineSummary = (f: MachineFact) =>
  [`${f.brand} ${f.modelRaw || "(no model on record)"}`.trim(), f.applianceType, f.availability, f.location].filter(Boolean).join(" · ");
export const FIELD_LABEL: Record<FieldName, string> = {
  availability: "status", condition: "condition", location: "location", diagnosis: "diagnosis", notes: "repair notes", stickerPrice: "sticker price"
};

/** Status words written on notes, mapped to Fleet statuses. Order matters: the first match wins per phrase. */
const STATUS_PHRASES: Array<[RegExp, string]> = [
  [/ready\s*(for|to)\s*(\$|s)\s*ale|\bfor\s*(\$|s)ale\b/i, "READY TO SALE"],
  [/parts?\s*program/i, "PARTS PROGRAM"],
  [/parts?\s*(machine|only|unit)|\bfor parts\b|\bharvest/i, "PARTS ONLY"],
  [/needs?\s*parts|waiting (on|for) parts/i, "NEEDS PARTS"],
  [/\bscrap/i, "SCRAPPED"],
  [/\bsold\b/i, "SOLD"],
  [/\bunchecked\b/i, "UNCHECKED"]
];
const READY_FOR_CLEAN = /ready\s*(for|to)\s*clean/i;
const statusFromPhrase = (p: string) => STATUS_PHRASES.find(([re]) => re.test(p))?.[1] ?? null;
/** A part family worth flagging ("other" is not). */
const flaggable = (family: string | null | undefined) => (family && family !== "other" ? family : null);

// Words on a note that only make sense for one kind of appliance.
const APPLIANCE_WORDS: Array<{ words: RegExp; label: string; fits: RegExp }> = [
  { words: /\b(gassing|gassed|refrigerant|freon|evap(orator)?|defrost|sealed system|not cooling|condenser)\b/i, label: "refrigerator", fits: /refrig|freezer|cooler|ice maker|wine|beverage|deli|a\/c/i },
  { words: /\b(agitat\w*|won'?t spin|lid switch|lid lock|dampers?|suspension rods?|transmission|clutch|gearcase|inner tub)\b/i, label: "washer", fits: /washer|combo|laundry/i },
  { words: /\b(drum rollers?|idler|lint|blower wheel)\b/i, label: "dryer", fits: /dryer|combo|laundry/i },
  { words: /\b(bake element|broil element|burner|igniter|cooktop|surface element)\b/i, label: "range", fits: /range|oven|cooktop|stove/i }
];
function applianceMismatch(entry: ReadEntry, applianceType: string): string | null {
  if (!applianceType.trim()) return null;
  const text = [entry.problem, entry.workDone, entry.note, ...entry.parts.map((p) => p.name), ...entry.symptoms.map((k) => CARD_SYMPTOMS.find((s) => s.key === k)?.phrase ?? "")].join(" ");
  for (const a of APPLIANCE_WORDS) {
    const m = a.words.exec(text);
    if (m && !a.fits.test(applianceType)) return m[0];
  }
  return null;
}

function bomLookup(bom: BomPart[], canonical: string): BomPart | null {
  return bom.find((b) => b.mpn === canonical)
    ?? bom.find((b) => `WP${b.mpn}` === canonical || b.mpn === `WP${canonical}`)
    ?? null;
}
function nearMpns(bom: BomPart[], canonical: string): BomPart[] {
  const bare = canonical.replace(/^WP/, "");
  return bom
    .map((b) => ({ b, d: Math.min(levenshtein(b.mpn.replace(/^WP/, ""), bare), levenshtein(b.mpn, canonical)) }))
    .filter(({ b, d }) => d <= (bare.length >= 7 ? 2 : 1) && b.mpn !== canonical)
    .sort((x, y) => x.d - y.d || x.b.mpn.localeCompare(y.b.mpn))
    .slice(0, 3)
    .map(({ b }) => b);
}
function partsByName(bom: BomPart[], name: string): BomPart[] {
  const words = name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3).map((w) => w.replace(/s$/, ""));
  if (!words.length) return [];
  return bom.filter((b) => words.every((w) => b.description.toLowerCase().includes(w))).slice(0, 6);
}

/**
 * What a part line means. Taken out → removed; replaced → replaced; written bad → failed;
 * written missing → missing; "needs" alone → needed; "check / maybe" → suspected.
 * A part only mentioned (no action, no condition) is not a decision.
 */
export function partKind(p: Pick<ReadPart, "action" | "condition">): PartKind | null {
  if (p.action === "taken") return "removed";
  if (p.action === "replaced") return "replaced";
  if (p.condition === "bad") return "failed";
  if (p.condition === "missing") return "missing";
  if (p.action === "needed") return "needed";
  if (p.action === "suspected") return "suspected";
  return null;
}

/** Precedence of a note dated `day` over a field or part decided at `own`, given the machine's newest decision. */
type Precedence = "apply" | "older" | "uncertain";
function precedence(day: string, own: Observed | undefined, last: Observed | null): Precedence {
  if (own && own.day > day) return "older";
  if (own && own.day === day) return "uncertain";
  if (last && last.day > day) return "uncertain";
  return "apply";
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------
export function planNote(reading: NoteReading, facts: PlanFacts, answers: Answers): Plan {
  const questions: Question[] = [];
  const locationsToAdd = new Map<string, Set<string>>();
  const aliasesToAdd = new Map<string, { name: string; alias: string }>();
  const known = (no: string | null | undefined): MachineFact | null => (no ? facts.machines[no] ?? null : null);

  /** Register a question; return its usable answer or null. */
  function ask(q: Omit<Question, "answer" | "error">, validate?: (answer: string) => string | null): string | null {
    const existing = questions.find((x) => x.id === q.id);
    if (existing) return existing.answer;
    const raw = answers[q.id];
    let answer: string | null = null;
    let error: string | undefined;
    if (raw != null) {
      const values = new Set(q.options.map((o) => o.value));
      const ok = q.multi
        ? raw === "" || raw.split(",").every((v) => values.has(v))
        : values.has(raw) || (Boolean(q.allowText) && raw.startsWith("text:") && raw.slice(5).trim() !== "");
      if (ok) {
        const problem = validate?.(raw) ?? null;
        if (problem) error = problem; else answer = raw;
      }
    }
    questions.push({ ...q, answer, ...(error ? { error } : {}) });
    return answer;
  }

  // --- Date: when the note was written (observation), not when it was uploaded ------------
  let date: string | null = null;
  const readDate = reading.date.text.trim();
  const parsed = readDate ? parseCardDate(readDate) : null;
  const why = !readDate ? "No date is written on this note."
    : !parsed ? `The date reads "${readDate}", which is not a date.`
    : parsed > facts.today ? `The date reads ${shortDate(parsed)}, which is after today.`
    : reading.date.confidence === "low" ? `The date reads ${shortDate(parsed)}, but it is hard to read.` : null;
  if (!why) date = parsed;
  else {
    const offered = [...new Set([...(parsed && parsed <= facts.today ? [parsed] : []), facts.uploadedOn, facts.today])];
    const a = ask({
      id: "date", kind: "date", entry: null,
      prompt: `${why} On what date were these observations made? An older date never overrides a newer record.`,
      options: offered.map((d) => ({
        value: `set:${d}`,
        label: d === parsed ? shortDate(d) : d === facts.uploadedOn ? `Upload date (${shortDate(d)})` : `Today (${shortDate(d)})`
      })),
      allowText: { label: "Date", placeholder: "5/12/26" }
    }, (v) => {
      if (!v.startsWith("text:")) return null;
      const d = parseCardDate(v.slice(5));
      return !d ? "Enter a date like 5/12/26." : d > facts.today ? "That date is after today." : null;
    });
    if (a) date = a.startsWith("set:") ? a.slice(4) : parseCardDate(a.slice(5))!;
  }
  // Until the date is settled, changes are previewed as of the upload date (nothing applies without it).
  const day = date ?? facts.uploadedOn;

  // --- Group lines (one line written for several machines) -----------------------------
  const groupMembers = new Map<string, ReadGroup[]>();
  reading.groups.forEach((g) => {
    const uncovered = reading.entries.filter((e) => !g.appliesTo.includes(e.key) && machineDigits(e.machine.text)
      && !e.status.checked && !e.status.phrases.length && !e.location.name && !e.location.text);
    let members = g.appliesTo;
    if (g.confidence === "low" || uncovered.length) {
      const a = ask({
        id: `group:${g.key}`, kind: "group", entry: null, multi: true,
        prompt: `"${g.text || [g.status.phrases.join(" "), g.location.text || g.location.name].join(" ").trim()}" is written once on this note. Which machines does it cover?`,
        options: reading.entries.filter((e) => machineDigits(e.machine.text)).map((e) => ({
          value: e.key, label: `#${machineDigits(e.machine.text)}`, recommended: g.appliesTo.includes(e.key)
        }))
      });
      members = a == null ? [] : a ? a.split(",") : [];
    }
    for (const k of members) groupMembers.set(k, [...(groupMembers.get(k) ?? []), g]);
  });

  // --- Machines ------------------------------------------------------------------------
  const resolved = new Map<string, { machineNo: string | null; skipped: boolean }>();
  const hasContent = (e: ReadEntry) => Boolean(e.status.checked || e.status.phrases.length || e.location.name || e.location.text || e.readyForClean
    || e.grade || e.price.text || e.symptoms.length || e.problem || e.workDone || e.note || e.parts.length || e.model || e.serial);
  for (const [i, e] of reading.entries.entries()) {
    const raw = machineDigits(e.machine.text);
    // A blank line (typed note not filled in yet) is not a question.
    if (!raw && !hasContent(e)) { resolved.set(e.key, { machineNo: null, skipped: true }); continue; }
    const f = known(raw);
    const reasons: string[] = [];
    const candidates: string[] = [];
    if (!raw) reasons.push("No machine number is written for it.");
    else if (!f) {
      reasons.push(`There is no machine #${raw}.`);
      candidates.push(...e.machine.alternatives.filter((a) => known(a)), ...nearMachineNumbers(raw).filter((n) => known(n)));
    } else {
      candidates.push(raw, ...e.machine.alternatives.filter((a) => a !== raw && known(a)));
      if (e.machine.confidence === "low" || e.machine.alternatives.some((a) => a !== raw)) reasons.push(`The number reads #${raw}, but it is hard to read.`);
      if (isOffLot(f.availability)) reasons.push(`#${raw} is recorded as ${f.availability}.`);
      const cardModel = modelKey(e.model);
      if (cardModel && f.modelRaw && !modelsAgree(cardModel, modelKey(f.modelRaw))) reasons.push(`The note says model ${e.model}, but #${raw} is a ${f.modelRaw}.`);
      const cardSerial = normSerial(e.serial);
      if (cardSerial && f.serial && levenshtein(cardSerial, normSerial(f.serial)) > 1) reasons.push(`The note says serial ${e.serial}, but #${raw} has serial ${f.serial}.`);
      const word = applianceMismatch(e, f.applianceType);
      if (word) reasons.push(`#${raw} is a ${f.applianceType}, but the note mentions "${word}".`);
    }
    const cardModel = modelKey(e.model);
    if (cardModel) {
      for (const m of Object.values(facts.machines)) {
        if (m.machineNo !== raw && modelKey(m.modelRaw) === cardModel && (!e.serial || normSerial(m.serial) === normSerial(e.serial))) candidates.push(m.machineNo);
      }
    }
    if (!reasons.length) { resolved.set(e.key, { machineNo: raw, skipped: false }); continue; }
    const options: QuestionOption[] = [...new Set(candidates)].slice(0, 6).map((no, j) => ({
      value: `use:${no}`, label: `#${no}`, detail: machineSummary(known(no)!), recommended: j === 0 && no === raw && !isOffLot(known(no)!.availability)
    }));
    options.push({ value: "skip", label: "Skip this entry", detail: "Nothing on this line is applied" });
    let resolvedNo: string | null = null;
    const a = ask({
      id: `machine:${e.key}`, kind: "machine", entry: e.key, prompt: `Entry ${i + 1}: ${reasons.join(" ")} Which machine is it?`,
      options, allowText: { label: "Machine #", placeholder: "number" }
    }, (v) => {
      if (v === "skip") return null;
      const no = v.startsWith("use:") ? v.slice(4) : machineDigits(v.slice(5));
      return known(no) ? null : `There is no machine #${no || v.slice(5)}.`;
    });
    if (a === "skip") { resolved.set(e.key, { machineNo: null, skipped: true }); continue; }
    if (a) resolvedNo = a.startsWith("use:") ? a.slice(4) : machineDigits(a.slice(5));
    // A typed or suggested number that turns out to be sold or scrapped is confirmed separately.
    const chosen = known(resolvedNo);
    if (chosen && resolvedNo !== raw && isOffLot(chosen.availability)) {
      const b = ask({
        id: `offlot:${e.key}:${resolvedNo}`, kind: "machine", entry: e.key,
        prompt: `#${resolvedNo} is recorded as ${chosen.availability}. Apply this note to it anyway?`,
        options: [{ value: "yes", label: `Yes, #${resolvedNo} is back on the lot` }, { value: "skip", label: "Skip this entry" }]
      });
      if (b === "skip") { resolved.set(e.key, { machineNo: null, skipped: true }); continue; }
      if (b == null) resolvedNo = null;
    }
    resolved.set(e.key, { machineNo: resolvedNo, skipped: false });
  }

  // The same machine twice on one note: pick which entry counts.
  const byMachine = new Map<string, ReadEntry[]>();
  for (const e of reading.entries) {
    const r = resolved.get(e.key)!;
    if (r.machineNo) byMachine.set(r.machineNo, [...(byMachine.get(r.machineNo) ?? []), e]);
  }
  for (const [no, list] of byMachine) {
    if (list.length < 2) continue;
    const a = ask({
      id: `duplicate:${no}`, kind: "duplicate", entry: null,
      prompt: `Machine #${no} is on this note ${list.length} times. Which entry should be applied?`,
      options: list.map((e) => ({ value: e.key, label: `Entry ${reading.entries.indexOf(e) + 1}` }))
    });
    for (const e of list) {
      if (a == null) resolved.set(e.key, { machineNo: null, skipped: false });
      else if (a !== e.key) resolved.set(e.key, { machineNo: null, skipped: true });
    }
  }

  // --- Locations -----------------------------------------------------------------------
  const vocab = facts.locations;
  const byNorm = new Map<string, string>();
  for (const l of vocab) {
    byNorm.set(normalizeLocation(l.name), l.name);
    for (const a of l.aliases) if (!byNorm.has(normalizeLocation(a))) byNorm.set(normalizeLocation(a), l.name);
  }
  const exactName = (name: string) => vocab.find((l) => l.name.toLowerCase() === name.trim().toLowerCase())?.name ?? null;
  const suggestions = (norm: string) => vocab
    .map((l) => {
      const n = normalizeLocation(l.name);
      const contains = (` ${norm} `).includes(` ${n} `) || (` ${n} `).includes(` ${norm} `);
      return { name: l.name, score: contains ? 0 : levenshtein(n, norm) / Math.max(n.length, norm.length, 1) };
    })
    .filter((s) => s.score <= 0.4)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((s) => s.name);

  /** Location named by a note: { name, detail } or "keep" (leave unchanged) or null (unanswered). */
  function resolveLocation(loc: ReadLocation, entryKey: string): { name: string; detail: string | null } | "keep" | null | undefined {
    const fromName = loc.name ? exactName(loc.name) : null;
    const text = loc.text.trim();
    const norm = normalizeLocation(text);
    if (!fromName && !norm) return undefined;
    const textName = norm ? byNorm.get(norm) ?? null : null;
    const name = fromName ?? textName;
    if (name) {
      const detail = text && normalizeLocation(text) !== normalizeLocation(name) && !textName ? text : null;
      if (loc.confidence !== "low") return { name, detail };
      const a = ask({
        id: `location:${entryKey}`, kind: "location", entry: entryKey,
        prompt: `The location looks like ${name}${detail ? ` (${detail})` : ""}, but it is hard to read. Where is the machine?`,
        options: [
          ...[...new Set([name, ...vocab.map((l) => l.name)])].map((n): QuestionOption => ({ value: `use:${n}`, label: n, recommended: n === name })),
          { value: "keep", label: "Leave location unchanged" }
        ]
      });
      if (a == null) return null;
      if (a === "keep") return "keep";
      return { name: a.slice(4), detail };
    }
    // Unknown words: ask once per distinct wording, for every entry that uses it.
    const close = suggestions(norm);
    const proposed = titleCaseLocation(text);
    const a = ask({
      id: `location:${norm}`, kind: "location", entry: null,
      prompt: `"${text}" is not one of the shop's locations yet. Where is that?`,
      options: [
        ...close.map((n, j) => ({ value: `use:${n}`, label: `Use ${n}`, detail: `Remember "${text}" as ${n}`, recommended: j === 0 })),
        { value: `add:${proposed}`, label: `Add "${proposed}" as a new location` },
        { value: "keep", label: "Leave location unchanged" }
      ],
      allowText: { label: "New location name", placeholder: proposed }
    }, (v) => (v.startsWith("text:") && exactName(v.slice(5)) ? `${v.slice(5).trim()} already exists. Pick it from the list.` : null));
    if (a == null) return null;
    if (a === "keep") return "keep";
    if (a.startsWith("use:")) {
      aliasesToAdd.set(`${a.slice(4)}|${norm}`, { name: a.slice(4), alias: norm });
      return { name: a.slice(4), detail: null };
    }
    const newName = titleCaseLocation(a.startsWith("add:") ? a.slice(4) : a.slice(5));
    const aliases = locationsToAdd.get(newName) ?? new Set<string>();
    if (normalizeLocation(newName) !== norm) aliases.add(norm);
    locationsToAdd.set(newName, aliases);
    return { name: newName, detail: null };
  }

  // --- Entries ------------------------------------------------------------------------
  /**
   * Builds every entry's changes. `veto` holds the answers to part-state conflicts across the note
   * (machine|mpn → the state kept, or null for neither): a decision whose state was not kept is not
   * applied, writes no state and adds nothing to the diagnosis.
   */
  const buildEntries = (veto: Map<string, string | null>): PlannedEntry[] => {
    const entries: PlannedEntry[] = [];
    const rejected = (machineNo: string, mpn: string | null, kind: PartKind) => {
      const k = `${machineNo}|${mpn}`;
      return mpn != null && veto.has(k) && STATE_FOR_KIND[kind] != null && STATE_FOR_KIND[kind] !== veto.get(k);
    };
    for (const [i, e] of reading.entries.entries()) {
      const r = resolved.get(e.key)!;
      const fact = known(r.machineNo);
      const planned: PlannedEntry = {
        key: e.key, label: `Entry ${i + 1}`, machineNo: r.machineNo, skipped: r.skipped, fact,
        changes: [], history: [], parts: [], partStates: [], testFirst: [], locationCheck: null, struck: e.struck, info: []
      };
      entries.push(planned);
      if (r.skipped || !fact) continue;
      const no = fact.machineNo;
      const groups = groupMembers.get(e.key) ?? [];

      // Location: the entry's own words win over a group line.
      let location: { name: string; detail: string | null } | "keep" | null | undefined = resolveLocation(e.location, e.key);
      if (location === undefined) {
        for (const g of groups) {
          const l = resolveLocation(g.location, e.key);
          if (l !== undefined) { location = l; break; }
        }
      }
      const nextLocation = location && location !== "keep" ? location.name : null;
      const locationChanged = nextLocation != null && nextLocation !== (fact.location ?? "");

      // Status: only a Fleet status the note actually says. Never from the location.
      const phrases = [...e.status.phrases, ...groups.flatMap((g) => g.status.phrases)];
      const statuses = new Set<string>();
      for (const c of [e.status.checked, ...groups.map((g) => g.status.checked)]) if (c && isNoteStatus(c)) statuses.add(c);
      const otherWords: string[] = [];
      for (const p of phrases) {
        const s = statusFromPhrase(p);
        if (s) statuses.add(s);
        else if (!READY_FOR_CLEAN.test(p) && (!nextLocation || normalizeLocation(p) !== normalizeLocation(nextLocation))) otherWords.push(p);
      }
      const readyForClean = e.readyForClean || phrases.some((p) => READY_FOR_CLEAN.test(p));
      const keep = { value: "keep", label: `Leave status as ${fact.availability}` };
      const statusOptions = (recommended?: string | null) => NOTE_STATUS_VALUES.filter((s) => s !== fact.availability)
        .map((s) => ({ value: `set:${s}`, label: s, recommended: s === recommended }));
      let target: string | null = null;
      if (statuses.size > 1) {
        const a = ask({
          id: `status:${e.key}`, kind: "status", entry: e.key,
          prompt: `#${no}: the note says more than one status (${[...statuses].join(", ")}). Which one is right?`,
          options: [...[...statuses].map((s) => ({ value: `set:${s}`, label: s })), keep]
        });
        target = a && a !== "keep" ? a.slice(4) : null;
      } else if (statuses.size === 1) {
        const only = [...statuses][0];
        if (e.status.checked === only && e.status.confidence === "low") {
          const a = ask({
            id: `status:${e.key}`, kind: "status", entry: e.key,
            prompt: `#${no}: the status looks like ${only}, but it is hard to read. Which is it?`,
            options: [...statusOptions(only), keep]
          });
          target = a && a !== "keep" ? a.slice(4) : null;
        } else target = only;
      } else if (fact.availability === "UNCHECKED") {
        const needed = e.parts.some((x) => partKind(x) === "needed" || partKind(x) === "failed" || partKind(x) === "missing");
        const describes = needed || e.symptoms.length > 0 || Boolean(e.problem || e.workDone);
        if (describes) {
          // Checked by a tech but still UNCHECKED: the status is the part of the note that is missing.
          const a = ask({
            id: `status:${e.key}`, kind: "status", entry: e.key,
            prompt: `#${no} is still UNCHECKED, but the note says what is wrong with it. What is its status now?`,
            options: [...["NEEDS PARTS", "PARTS ONLY", "PARTS PROGRAM", "READY TO SALE"].map((s) => ({ value: `set:${s}`, label: s, recommended: needed && s === "NEEDS PARTS" })),
              { value: "keep", label: "Leave it UNCHECKED" }]
          });
          target = a && a !== "keep" ? a.slice(4) : null;
        }
      }
      if (target && target !== fact.availability && isOffLot(target) && !isOffLot(fact.availability)) {
        // Leaving the lot takes the machine off every donor list: confirm it.
        const a = ask({
          id: `offlot-status:${e.key}`, kind: "status", entry: e.key,
          prompt: `#${no} would be marked ${target}. That takes it off the lot and off every donor list. Is that right?`,
          options: [{ value: "yes", label: `Yes, mark it ${target}` }, keep]
        });
        if (a !== "yes") target = null;
      }
      const statusChanged = target != null && target !== fact.availability;
      const effectiveStatus = statusChanged ? target! : fact.availability;

      // Condition: follows the status (grade when for sale).
      let condition: string | null = null;
      if (effectiveStatus === "READY TO SALE") {
        if (e.grade) condition = gradeCondition(e.grade);
        else if (statusChanged && !isSaleCondition(fact.condition)) {
          const a = ask({
            id: `grade:${e.key}`, kind: "grade", entry: e.key, prompt: `#${no} is going up for sale. What grade is it?`,
            options: SALE_GRADES.map((g) => ({ value: `set:${g.condition}`, label: g.condition, recommended: g.grade === "B" }))
          });
          condition = a ? a.slice(4) : null;
        }
      } else if (statusChanged) {
        condition = CONDITION_FOR_STATUS[effectiveStatus] ?? null;
        if (e.grade) planned.info.push(`Grade ${e.grade} is not used: #${no} is not for sale.`);
      } else if (e.grade) planned.info.push(`Grade ${e.grade} is not used: #${no} is not for sale.`);

      // Price
      let price: string | null = null;
      if (e.price.text) {
        const read = money(e.price.text);
        if (read && e.price.confidence !== "low") price = read;
        else {
          const a = ask({
            id: `price:${e.key}`, kind: "price", entry: e.key,
            prompt: read ? `#${no}: the price looks like $${read}, but it is hard to read. What is the sticker price?` : `#${no}: the price reads "${e.price.text}". What is the sticker price?`,
            options: [...(read ? [{ value: `set:${read}`, label: `$${read}` }] : []), { value: "keep", label: "Leave the price unchanged" }],
            allowText: { label: "Price $", placeholder: "350" }
          }, (v) => (v.startsWith("text:") && !money(v.slice(5)) ? "Enter a dollar amount." : null));
          price = a == null || a === "keep" ? null : a.startsWith("set:") ? a.slice(4) : money(a.slice(5));
        }
      }

      // Parts
      const bom = fact.bomStatus === "found" ? fact.bomParts : null;
      const resolvePart = (p: ReadPart, kind: PartKind | null): { mpn: string | null; display: string; family: string | null } | "drop" => {
        const canonical = canonicalizeMpn(p.mpn);
        const byName = p.name ? classifyFamily(p.name) : "other";
        const nameFamily = byName === "other" ? null : byName;
        if (canonical) {
          if (!bom) {
            planned.info.push(`No parts list is cached for ${fact.brand} ${fact.modelRaw || "this model"}, so ${p.mpn} goes in the notes only.`);
            return { mpn: null, display: p.mpn, family: nameFamily };
          }
          const hit = bomLookup(bom, canonical);
          if (hit) return { mpn: hit.mpn, display: hit.display, family: flaggable(hit.family) ?? nameFamily };
          const near = nearMpns(bom, canonical);
          const a = ask({
            id: `part:${e.key}:${p.key}`, kind: "part", entry: e.key,
            prompt: `#${no}: ${p.mpn}${p.name ? ` (${p.name})` : ""} is not in the parts list for ${fact.brand} ${fact.modelRaw}.${near.length ? " Did you mean one of these?" : ""}`,
            options: [
              ...near.map((b, j) => ({ value: `use:${b.mpn}`, label: `Use ${b.display}`, detail: b.description, recommended: j === 0 })),
              { value: "keep", label: `Keep ${p.mpn} as written`, detail: "It goes in the notes only" },
              { value: "drop", label: "Leave this part out" }
            ]
          });
          if (a == null || a === "keep") return { mpn: null, display: p.mpn, family: nameFamily };
          if (a === "drop") return "drop";
          const chosen = bom.find((b) => b.mpn === a.slice(4))!;
          return { mpn: chosen.mpn, display: chosen.display, family: flaggable(chosen.family) ?? nameFamily };
        }
        if (bom && kind && kind !== "suspected" && kind !== "replaced") {
          const cands = partsByName(bom, p.name);
          if (cands.length) {
            const a = ask({
              id: `part:${e.key}:${p.key}`, kind: "part", entry: e.key,
              prompt: `#${no}: which part in the ${fact.brand} ${fact.modelRaw} parts list is "${p.name}"?`,
              options: [
                ...cands.map((b) => ({ value: `use:${b.mpn}`, label: b.display, detail: b.description })),
                { value: "keep", label: "Not sure: notes only" }
              ]
            });
            if (a && a.startsWith("use:")) {
              const chosen = bom.find((b) => b.mpn === a.slice(4))!;
              return { mpn: chosen.mpn, display: chosen.display, family: flaggable(chosen.family) ?? nameFamily };
            }
          }
        }
        return { mpn: null, display: p.mpn, family: nameFamily };
      };
      const resolveOther = (p: ReadPart): { no: string | null; label: string } => {
        const raw = p.otherMachine;
        if (known(raw)) return { no: raw, label: `#${raw}` };
        const a = ask({
          id: `other:${e.key}:${p.key}`, kind: "other_machine", entry: e.key,
          prompt: `#${no}: the part line names machine #${raw}, which is not in the fleet. Which machine is it?`,
          options: [
            ...nearMachineNumbers(raw).filter((n) => known(n)).slice(0, 4).map((n) => ({ value: `use:${n}`, label: `#${n}`, detail: machineSummary(known(n)!) })),
            { value: "keep", label: `Keep "#${raw}" in the notes only` }
          ],
          allowText: { label: "Machine #", placeholder: "number" }
        }, (v) => {
          if (v === "keep") return null;
          const n = v.startsWith("use:") ? v.slice(4) : machineDigits(v.slice(5));
          return known(n) ? null : `There is no machine #${n}.`;
        });
        if (a == null || a === "keep") return { no: null, label: `#${raw}` };
        const n = a.startsWith("use:") ? a.slice(4) : machineDigits(a.slice(5));
        return { no: n, label: `#${n}` };
      };

      type DraftPart = PartDecision & { diagnosisBit: string; noteBit: string; precedence: Precedence; rejected?: boolean };
      const draftParts: DraftPart[] = [];
      const donorParts: Array<PartDecision & { donor: MachineFact; precedence: Precedence }> = [];
      const mentionBits: string[] = [];
      for (const p of e.parts) {
        const kind = partKind(p);
        const part = resolvePart(p, kind);
        if (part === "drop") continue;
        const label = `${p.name || "part"}${part.display ? ` (${part.display})` : ""}`;
        const other = p.otherMachine ? resolveOther(p) : null;
        if (!kind) { mentionBits.push(sentence(label)); continue; }
        // A hard-to-read line that would take a part off pick lists (here or on a donor) is confirmed first,
        // even when its number matches the parts list: a match does not make the reading certain.
        if (p.confidence === "low" && (STATE_FOR_KIND[kind] || (kind === "replaced" && other?.no))) {
          const a = ask({
            id: `partread:${e.key}:${p.key}`, kind: "part", entry: e.key,
            prompt: `#${no}: a part line reads "${label}: ${kind}${other ? ` (${kind === "replaced" ? "from" : "for"} ${other.label})` : ""}", but it is hard to read. Is that right?`,
            options: [
              { value: "yes", label: `Yes, ${label} ${PART_KIND_LABEL[kind]}` },
              { value: "notes", label: "Keep it in the repair notes only", detail: "No part is marked" },
              { value: "drop", label: "Leave this line out" }
            ]
          });
          if (a === "drop") continue;
          if (a !== "yes") { mentionBits.push(sentence(`${label}: ${kind}`)); continue; }
        }
        const alreadySaid = !part.display && p.name && e.problem.toLowerCase().includes(p.name.toLowerCase());
        const diagnosisBit = alreadySaid ? "" : kind === "needed" ? sentence(`Needs ${label}`) : kind === "suspected" ? sentence(`Check ${label}`)
          : kind === "failed" ? sentence(`Bad ${label}`) : kind === "missing" ? sentence(`${label} missing`) : "";
        const noteBit = kind === "removed" ? sentence(`Took ${label}${other ? ` for ${other.label}` : ""}`)
          : kind === "replaced" ? sentence(`Replaced ${label}${other ? ` from ${other.label}` : ""}`) : "";
        draftParts.push({
          machineNo: no, mpn: part.mpn, mpnDisplay: part.display, name: p.name, kind, otherMachine: other?.no ?? null, applied: true,
          testFirst: kind === "needed" || kind === "suspected" ? part.family : null,
          note: other?.no ? (kind === "removed" ? `for #${other.no}` : `from #${other.no}`) : "tech note",
          diagnosisBit, noteBit, precedence: "apply"
        });
        if (kind === "replaced" && part.mpn) {
          const donor = known(other?.no);
          if (donor) {
            // The donor's own parts-list identity (WP3948891 and 3948891 are different keys), when it has a list.
            const donorHit = donor.bomStatus === "found" ? bomLookup(donor.bomParts, part.mpn) : null;
            if (isOffLot(donor.availability)) planned.info.push(`#${donor.machineNo} is ${donor.availability}, so no part is marked removed there.`);
            else if (donor.bomStatus === "found" && !donorHit) planned.info.push(`${part.display} is not in #${donor.machineNo}'s parts list, so it is not marked removed there.`);
            else {
              const mpn = donorHit?.mpn ?? part.mpn;
              donorParts.push({
                machineNo: donor.machineNo, mpn, mpnDisplay: donorHit?.display ?? part.display, name: p.name, kind: "removed", otherMachine: no,
                applied: true, testFirst: null, note: `for #${no}`, donor, precedence: precedence(day, donor.partUpdates[mpn], donor.lastUpdate)
              });
            }
          }
        }
      }

      // --- Precedence: an older note never reverses a newer decision -------------------------
      const symptomBits = [...e.symptoms.map((k) => CARD_SYMPTOMS.find((s) => s.key === k)?.phrase ?? ""), sentence(e.problem)].filter(Boolean);
      const wants: Partial<Record<TrackedField, boolean>> = {
        availability: statusChanged,
        condition: condition != null && condition !== (fact.condition ?? ""),
        location: locationChanged,
        stickerPrice: price != null && !sameMoney(price, fact.stickerPrice),
        diagnosis: symptomBits.length > 0 || draftParts.some((d) => d.diagnosisBit)
      };
      const fieldPrecedence: Partial<Record<TrackedField, Precedence>> = {};
      for (const f of Object.keys(wants) as TrackedField[]) if (wants[f]) fieldPrecedence[f] = precedence(day, fact.fieldUpdates[f], fact.lastUpdate);
      // Condition is written with the status: it never outlives a status kept as history.
      if (fieldPrecedence.availability && fieldPrecedence.condition) {
        const rank = { older: 2, uncertain: 1, apply: 0 } as const;
        if (rank[fieldPrecedence.availability] > rank[fieldPrecedence.condition]) fieldPrecedence.condition = fieldPrecedence.availability;
      }
      // A part with a parts-list number has its own record; a named part follows the diagnosis.
      for (const d of draftParts) {
        d.precedence = d.mpn ? precedence(day, fact.partUpdates[d.mpn], fact.lastUpdate)
          : fieldPrecedence.diagnosis ?? precedence(day, fact.fieldUpdates.diagnosis, fact.lastUpdate);
      }
      // When part of this note is certainly older than the record, the note as a whole predates it:
      // fields the record has not set since are history too, not a question. Same-day ties still ask.
      if (Object.values(fieldPrecedence).includes("older") || draftParts.some((d) => d.mpn && d.precedence === "older")) {
        for (const f of Object.keys(fieldPrecedence) as TrackedField[]) {
          if (fieldPrecedence[f] === "uncertain" && fact.fieldUpdates[f]?.day !== day) fieldPrecedence[f] = "older";
        }
        for (const d of draftParts) if (d.precedence === "uncertain" && (!d.mpn || fact.partUpdates[d.mpn]?.day !== day)) d.precedence = "older";
      }
      const uncertainFields = (Object.keys(fieldPrecedence) as TrackedField[]).filter((f) => fieldPrecedence[f] === "uncertain");
      const uncertainParts = draftParts.filter((d) => d.mpn && d.precedence === "uncertain");
      // A donor's part has its own record: the same rules, the same question.
      const uncertainDonors = donorParts.filter((d) => d.precedence === "uncertain");
      let uncertainApplies = false;
      if (uncertainFields.length || uncertainParts.length || uncertainDonors.length) {
        const what = [...uncertainFields.map((f) => FIELD_LABEL[f]), ...uncertainParts.map((d) => `${d.name || "part"} (${d.mpnDisplay || "no number"}) as ${d.kind}`),
          ...uncertainDonors.map((d) => `#${d.machineNo}'s ${d.name || "part"} (${d.mpnDisplay}) as removed`)];
        const sameDay = [...uncertainFields.filter((f) => fact.fieldUpdates[f]?.day === day).map((f) => `${FIELD_LABEL[f]} was set ${fact.fieldUpdates[f]!.label}`),
          ...uncertainParts.filter((d) => d.mpn && fact.partUpdates[d.mpn]?.day === day).map((d) => `${d.mpnDisplay} was set ${fact.partUpdates[d.mpn!]!.label}`),
          ...uncertainDonors.filter((d) => d.donor.partUpdates[d.mpn!]?.day === day).map((d) => `#${d.machineNo}'s ${d.mpnDisplay} was set ${d.donor.partUpdates[d.mpn!]!.label}`)];
        const newer = (uncertainFields.length || uncertainParts.length) && fact.lastUpdate && fact.lastUpdate.day > day;
        const newerDonors = [...new Set(uncertainDonors.filter((d) => d.donor.lastUpdate && d.donor.lastUpdate.day > day).map((d) => d.donor))];
        const reason = [
          ...(sameDay.length ? [`On the same day, ${sameDay.join("; ")}.`] : []),
          ...(newer ? [`#${no} was updated ${fact.lastUpdate!.label}, after this note's date.`] : []),
          ...newerDonors.map((dn) => `#${dn.machineNo} was updated ${dn.lastUpdate!.label}, after this note's date.`)
        ].join(" ");
        const a = ask({
          id: `order:${e.key}`, kind: "order", entry: e.key,
          prompt: `#${no}: this note is dated ${shortDate(day)}. ${reason} Is this note the latest word on its ${what.join(", ")}?`,
          options: [
            { value: "apply", label: "Yes, apply them", detail: "This note is newer than the record" },
            { value: "history", label: "No, keep the current record", detail: "Save what this note says as history only", recommended: Boolean(newer) || newerDonors.length > 0 }
          ]
        });
        uncertainApplies = a === "apply";
      }
      const applies = (p: Precedence | undefined) => p === "apply" || (p === "uncertain" && uncertainApplies);
      for (const d of draftParts) d.rejected = rejected(no, d.mpn, d.kind);

      // Parts: applied decisions change availability; older ones are history.
      for (const d of draftParts) {
        const ok = applies(d.precedence) && !d.rejected;
        if (d.rejected) planned.info.push(`${d.name || d.mpnDisplay} on #${no} is not recorded as ${d.kind}: you chose another line for it.`);
        const { diagnosisBit: _d, noteBit: _n, precedence: _p, rejected: _r, ...decision } = d;
        planned.parts.push({ ...decision, applied: ok });
        const state = STATE_FOR_KIND[d.kind];
        if (ok && state && d.mpn) planned.partStates.push({ machineNo: no, mpn: d.mpn, mpnDisplay: d.mpnDisplay, state, note: d.note, seenToken: fact.partUpdates[d.mpn]?.token ?? null });
        if (ok && d.testFirst && !planned.testFirst.includes(d.testFirst)) planned.testFirst.push(d.testFirst);
      }
      for (const { donor, precedence: pr, ...d } of donorParts) {
        const no2 = rejected(d.machineNo, d.mpn, d.kind);
        const ok = applies(pr) && !no2;
        if (no2) planned.info.push(`#${d.machineNo}'s ${d.mpnDisplay} is not recorded as removed: you chose another line for it.`);
        planned.parts.push({ ...d, applied: ok });
        if (ok && d.mpn) planned.partStates.push({ machineNo: d.machineNo, mpn: d.mpn, mpnDisplay: d.mpnDisplay, state: "pulled", note: d.note, seenToken: donor.partUpdates[d.mpn]?.token ?? null });
        if (!applies(pr)) planned.info.push(`#${d.machineNo}'s ${d.mpnDisplay} has a newer record, so it is not marked removed there.`);
      }

      // Diagnosis: what is wrong, appended to what the record already says.
      const current = (fact.diagnosis ?? "").trim();
      const said = [...new Set([...symptomBits, ...draftParts.map((d) => d.diagnosisBit).filter(Boolean)])];
      const bits = [...symptomBits, ...draftParts.filter((d) => d.diagnosisBit && applies(d.precedence) && !d.rejected).map((d) => d.diagnosisBit)]
        .filter((b) => b && !current.toLowerCase().includes(b.toLowerCase().replace(/\.$/, "")));
      const diagnosis = bits.length ? [current, ...new Set(bits)].filter(Boolean).join(" ") : null;

      const want: Array<[TrackedField, string | null, string | null]> = [
        ["availability", fact.availability, statusChanged ? target : null],
        ["condition", fact.condition, condition],
        ["location", fact.location, nextLocation],
        ["diagnosis", fact.diagnosis, diagnosis],
        ["stickerPrice", fact.stickerPrice, price && !sameMoney(price, fact.stickerPrice) ? price : null]
      ];
      const historyNotes: string[] = [];
      for (const [field, from, to] of want) {
        if (to == null || (from ?? "") === to) continue;
        const p = fieldPrecedence[field] ?? "apply";
        if (applies(p)) planned.changes.push({ field, from, to });
        else {
          // History keeps what the note said, not the merged text.
          planned.history.push({ field, from, to: field === "diagnosis" ? said.join(" ") : to });
          historyNotes.push(FIELD_LABEL[field]);
        }
      }
      if (said.length && !planned.changes.some((c) => c.field === "diagnosis") && !planned.history.some((c) => c.field === "diagnosis")
        && fieldPrecedence.diagnosis && !applies(fieldPrecedence.diagnosis)) {
        planned.history.push({ field: "diagnosis", from: fact.diagnosis, to: said.join(" ") });
        historyNotes.push(FIELD_LABEL.diagnosis);
      }
      const applied = (field: TrackedField) => planned.changes.some((c) => c.field === field);

      // VERIFY LOCATION: a recorded location that differs from the one on record.
      if (applied("location") && (fact.location ?? "").trim()) {
        planned.locationCheck = { from: fact.location!, to: nextLocation! };
        planned.info.push(`#${no} was recorded at ${fact.location}; this note says ${nextLocation}. VERIFY LOCATION stays on until someone checks where it is.`);
      }
      // Donor pool consequence of a status change.
      if (applied("availability")) {
        const was = facts.donorStatuses.includes(fact.availability);
        const will = facts.donorStatuses.includes(target!);
        if (!was && will) planned.info.push(`#${no} joins the donor pool: ${target} is a donor status in Settings.`);
        if (was && !will) planned.info.push(`#${no} leaves the donor pool.`);
      }

      // Repair notes: one dated line, the inventory's "5/12/26-…" style. Always appended: it is the log.
      const line: string[] = [];
      if (locationChanged) line.push(`Location: ${nextLocation}${location && location !== "keep" && location.detail ? ` (${location.detail})` : ""}.`);
      if (statusChanged) line.push(`${target}.`);
      if (otherWords.length) line.push(...otherWords.map(sentence));
      if (readyForClean) line.push("Ready for clean.");
      if (e.workDone) line.push(sentence(e.workDone));
      line.push(...draftParts.map((d) => d.noteBit).filter(Boolean), ...mentionBits);
      if (price && !sameMoney(price, fact.stickerPrice)) line.push(`Sticker $${Number(price).toFixed(2).replace(/\.00$/, "")}.`);
      if (e.note) line.push(sentence(e.note));
      if (historyNotes.length || draftParts.some((d) => !applies(d.precedence)) || donorParts.some((d) => !applies(d.precedence))) {
        if (!applies(fieldPrecedence.diagnosis ?? "apply")) line.push(...said);
        line.push("(Older than the current record: kept as history.)");
      }
      const notesLine = line.length ? `${shortDate(day)}-${line.join(" ")}` : "";
      if (notesLine) {
        const currentNotes = (fact.notes ?? "").trim();
        planned.changes.push({ field: "notes", from: fact.notes, to: [currentNotes, notesLine].filter(Boolean).join(" ") });
      }
    }
    return entries;
  };
  let entries = buildEntries(new Map());

  // One part on one machine gets one availability state per note. The same state written twice is
  // written once; different states (a part "taken" on one line and "missing" on another) are asked.
  const byPart = new Map<string, Array<{ entry: PlannedEntry; change: PartStateChange }>>();
  for (const entry of entries) for (const change of entry.partStates) {
    const k = `${change.machineNo}|${change.mpn}`;
    byPart.set(k, [...(byPart.get(k) ?? []), { entry, change }]);
  }
  const veto = new Map<string, string | null>();
  for (const [k, list] of byPart) {
    const states = [...new Set(list.map((x) => x.change.state))];
    if (states.length < 2) continue;
    const [machineNo] = k.split("|");
    const a = ask({
      id: `partstate:${k}`, kind: "part", entry: null,
      prompt: `#${machineNo}: this note marks ${list[0].change.mpnDisplay} as ${states.map((st) => (st === "pulled" ? "removed" : st)).join(" and as ")}. Which is right?`,
      options: [...states.map((st) => ({ value: `set:${st}`, label: st === "pulled" ? "removed" : st })), { value: "none", label: "Neither: leave the part as it is" }]
    });
    // Unanswered: nothing is written for this part until it is (and the note is not ready).
    veto.set(k, a == null || a === "none" ? null : a.slice(4));
  }
  // The answers change decisions, diagnoses and notes, not only the state rows: build the entries again.
  if (veto.size) entries = buildEntries(veto);
  // The same state written twice is written once.
  const written = new Set<string>();
  for (const entry of entries) {
    entry.partStates = entry.partStates.filter((x) => {
      const k = `${x.machineNo}|${x.mpn}`;
      if (written.has(k)) return false;
      written.add(k);
      return true;
    });
  }

  const unanswered = questions.filter((q) => q.answer == null).length;
  const hasChanges = entries.some((e) => e.changes.length || e.history.length || e.parts.length);
  return {
    date,
    uploadedOn: facts.uploadedOn,
    entries,
    questions,
    locationsToAdd: [...locationsToAdd].map(([name, aliases]) => ({ name, aliases: [...aliases] })),
    aliasesToAdd: [...aliasesToAdd.values()],
    unanswered,
    hasChanges,
    ready: unanswered === 0 && hasChanges && date != null
  };
}
