/**
 * Turns a tech-note reading into (a) the questions a person must answer and (b) the exact
 * changes that will be written. Pure and deterministic: the review page runs it live in the
 * browser, and the server runs it again on apply with fresh facts before writing anything.
 *
 * It never guesses. Anything the reading and the machine record cannot settle on their own
 * becomes a question, and nothing is ready to apply until every question has an answer.
 */
import { canonicalizeMpn } from "@/src/lib/mpn";
import { modelKey } from "@/src/lib/model-key";
import {
  CONDITION_FOR_STATUS, CARD_STATUS_VALUES, CARD_SYMPTOMS, OFF_LOT_STATUSES, SALE_GRADES,
  gradeCondition, isSaleCondition, normalizeLocation, parseCardDate, shortDate, statusLabel, titleCaseLocation
} from "./vocabulary";
import { machineDigits, type NoteReading, type ReadEntry, type ReadGroup, type ReadLocation, type ReadPart } from "./reading";

// ---------------------------------------------------------------------------
// Facts: the fleet records the planner may consult.
// ---------------------------------------------------------------------------
export type BomPart = { mpn: string; display: string; description: string };
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
};
export type LocationFact = { name: string; aliases: string[] };
export type PlanFacts = {
  machines: Record<string, MachineFact>;
  locations: LocationFact[];
  /** Shop calendar day, YYYY-MM-DD. */
  today: string;
};
/** Question id → chosen option value ("use:6146", "set:READY TO SALE", "keep", "text:…", "e0,e2"). */
export type Answers = Record<string, string>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
export type FieldName = "availability" | "condition" | "location" | "diagnosis" | "notes" | "stickerPrice";
export type FieldChange = { field: FieldName; from: string | null; to: string | null };
export type PartStateChange = { machineNo: string; mpn: string; mpnDisplay: string; state: "pulled" | "failed" | "missing"; note: string };
export type QuestionKind = "date" | "machine" | "duplicate" | "group" | "status" | "grade" | "location" | "part" | "other_machine" | "price";
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
  changes: FieldChange[];
  partStates: PartStateChange[];
  struck: string[];
  info: string[];
};
export type Plan = {
  date: string;
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

// Status words written on free notes.
const STATUS_PHRASES: Array<[RegExp, string]> = [
  [/ready\s*(for|to)\s*(\$|s)\s*ale|\bfor\s*(\$|s)ale\b/i, "READY TO SALE"],
  [/parts?\s*(machine|only|unit)|\bfor parts\b|\bharvest/i, "PARTS ONLY"],
  [/\bicu\b|needs?\s*parts|waiting (on|for) parts/i, "NEEDS PARTS"],
  [/being repaired|in (the )?shop|on the bench/i, "BEING REPAIRED"],
  [/\bscrap/i, "SCRAPPED"]
];
const READY_FOR_CLEAN = /ready\s*(for|to)\s*clean/i;

/** Where a machine usually sits for a status, as the inventory pairs them. */
function statusForLocation(name: string): string | null {
  if (/^showroom/i.test(name)) return "READY TO SALE";
  if (name === "ICU") return "NEEDS PARTS";
  if (name === "Graveyard") return "PARTS ONLY";
  if (name === "Shop") return "BEING REPAIRED";
  return null;
}

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

  // --- Date -------------------------------------------------------------------------
  let date = facts.today;
  const readDate = reading.date.text.trim();
  if (readDate) {
    const parsed = parseCardDate(readDate);
    const why = !parsed ? `The date reads "${readDate}", which is not a date.`
      : parsed > facts.today ? `The date reads ${shortDate(parsed)}, which is after today.`
      : reading.date.confidence === "low" ? `The date reads ${shortDate(parsed)}, but it is hard to read.` : null;
    if (!why) date = parsed!;
    else {
      const a = ask({
        id: "date", kind: "date", entry: null, prompt: `${why} Which date goes in the repair notes?`,
        options: [
          ...(parsed && parsed <= facts.today ? [{ value: `set:${parsed}`, label: shortDate(parsed) }] : []),
          { value: `set:${facts.today}`, label: `Today (${shortDate(facts.today)})` }
        ],
        allowText: { label: "Date", placeholder: "5/12/26" }
      }, (v) => (v.startsWith("text:") && !parseCardDate(v.slice(5)) ? "Enter a date like 5/12/26." : null));
      if (a) date = a.startsWith("set:") ? a.slice(4) : parseCardDate(a.slice(5))!;
    }
  }

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

  /** Location named by a card or note: { name, detail } or "keep" (leave unchanged) or null (unanswered). */
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
        { value: `add:${proposed}`, label: `Add "${proposed}" as a new location`, detail: "It will be printed on new cards" },
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
  const entries: PlannedEntry[] = [];
  for (const [i, e] of reading.entries.entries()) {
    const r = resolved.get(e.key)!;
    const fact = known(r.machineNo);
    const planned: PlannedEntry = {
      key: e.key, label: `Entry ${i + 1}`, machineNo: r.machineNo, skipped: r.skipped, fact,
      changes: [], partStates: [], struck: e.struck, info: []
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

    // Status
    const phrases = [...e.status.phrases, ...groups.flatMap((g) => g.status.phrases)];
    const statuses = new Set<string>();
    for (const c of [e.status.checked, ...groups.map((g) => g.status.checked)]) if (c && CARD_STATUS_VALUES.includes(c)) statuses.add(c);
    for (const p of phrases) for (const [re, s] of STATUS_PHRASES) if (re.test(p)) statuses.add(s);
    const readyForClean = e.readyForClean || phrases.some((p) => READY_FOR_CLEAN.test(p));
    const keep = { value: "keep", label: `Leave status as ${fact.availability}` };
    let target: string | null = null;
    if (statuses.size > 1) {
      const a = ask({
        id: `status:${e.key}`, kind: "status", entry: e.key,
        prompt: `#${no}: the note marks more than one status (${[...statuses].map(statusLabel).join(", ")}). Which one is right?`,
        options: [...[...statuses].map((s) => ({ value: `set:${s}`, label: statusLabel(s) })), keep]
      });
      target = a && a !== "keep" ? a.slice(4) : null;
    } else if (statuses.size === 1) {
      const only = [...statuses][0];
      if (e.status.checked === only && e.status.confidence === "low") {
        const a = ask({
          id: `status:${e.key}`, kind: "status", entry: e.key,
          prompt: `#${no}: the marked status looks like ${statusLabel(only)}, but it is hard to read. Which is it?`,
          options: [...CARD_STATUS_VALUES.map((s) => ({ value: `set:${s}`, label: statusLabel(s), recommended: s === only })), keep]
        });
        target = a && a !== "keep" ? a.slice(4) : null;
      } else target = only;
    } else if (readyForClean) {
      if (nextLocation && /^showroom/i.test(nextLocation)) {
        target = "READY TO SALE";
        planned.info.push(`"Ready for clean" on the showroom floor is read as READY TO SALE.`);
      } else {
        const a = ask({
          id: `status:${e.key}`, kind: "status", entry: e.key,
          prompt: `#${no} is marked "Ready for clean". What is its status now?`,
          options: [
            { value: "set:READY TO SALE", label: "Ready for sale" },
            { value: "set:BEING REPAIRED", label: "Being repaired (not cleaned yet)" },
            keep
          ]
        });
        target = a && a !== "keep" ? a.slice(4) : null;
      }
    } else {
      const usual = locationChanged ? statusForLocation(nextLocation!) : null;
      const needed = e.parts.some((x) => x.action === "needed");
      const describes = needed || e.symptoms.length > 0 || Boolean(e.problem || e.workDone);
      if (usual && usual !== fact.availability) {
        const a = ask({
          id: `status:${e.key}`, kind: "status", entry: e.key,
          prompt: `#${no} is moving to ${nextLocation}. Machines there are usually ${usual}. Change its status?`,
          options: [{ value: `set:${usual}`, label: `Yes, ${statusLabel(usual)}`, recommended: true }, keep]
        });
        target = a && a !== "keep" ? a.slice(4) : null;
      } else if (fact.availability === "UNCHECKED" && describes) {
        // Checked by a tech but still UNCHECKED: the status is the part of the note that is missing.
        const a = ask({
          id: `status:${e.key}`, kind: "status", entry: e.key,
          prompt: `#${no} is still UNCHECKED, but the note says what is wrong with it. What is its status now?`,
          options: [
            { value: "set:NEEDS PARTS", label: "Needs parts", recommended: needed },
            { value: "set:BEING REPAIRED", label: "Being repaired" },
            { value: "set:PARTS ONLY", label: "Parts machine" },
            keep
          ]
        });
        target = a && a !== "keep" ? a.slice(4) : null;
      }
    }
    const statusChanged = target != null && target !== fact.availability;
    const effectiveStatus = statusChanged ? target! : fact.availability;

    // Condition
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
    const resolvePart = (p: ReadPart): { mpn: string | null; display: string } | "drop" => {
      const canonical = canonicalizeMpn(p.mpn);
      if (canonical) {
        if (!bom) {
          planned.info.push(`No parts list is cached for ${fact.brand} ${fact.modelRaw || "this model"}, so ${p.mpn} goes in the notes only.`);
          return { mpn: null, display: p.mpn };
        }
        const hit = bomLookup(bom, canonical);
        if (hit) return { mpn: hit.mpn, display: hit.display };
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
        if (a == null || a === "keep") return { mpn: null, display: p.mpn };
        if (a === "drop") return "drop";
        const chosen = bom.find((b) => b.mpn === a.slice(4))!;
        return { mpn: chosen.mpn, display: chosen.display };
      }
      if (bom && (p.action === "needed" || p.action === "taken")) {
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
            return { mpn: chosen.mpn, display: chosen.display };
          }
        }
      }
      return { mpn: null, display: p.mpn };
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
    const diagnosisBits: string[] = [];
    const noteBits: string[] = [];
    for (const p of e.parts) {
      const part = resolvePart(p);
      if (part === "drop") continue;
      const label = `${p.name || "part"}${part.display ? ` (${part.display})` : ""}`;
      const other = p.otherMachine ? resolveOther(p) : null;
      if (p.action === "needed") {
        // "need inner tub" in the problem text already says it unless the line adds a part number.
        const alreadySaid = !part.display && p.name && e.problem.toLowerCase().includes(p.name.toLowerCase());
        if (!alreadySaid) diagnosisBits.push(p.condition === "missing" ? sentence(`${label} missing`) : sentence(`Needs ${label}`));
        if (part.mpn) planned.partStates.push({ machineNo: no, mpn: part.mpn, mpnDisplay: part.display, state: p.condition === "missing" ? "missing" : "failed", note: "tech note" });
      } else if (p.action === "taken") {
        noteBits.push(sentence(`Took ${label}${other ? ` for ${other.label}` : ""}`));
        if (part.mpn) planned.partStates.push({ machineNo: no, mpn: part.mpn, mpnDisplay: part.display, state: "pulled", note: other?.no ? `for #${other.no}` : "tech note" });
      } else if (p.action === "replaced") {
        noteBits.push(sentence(`Replaced ${label}${other ? ` from ${other.label}` : ""}`));
        const donor = known(other?.no);
        if (part.mpn && donor) {
          if (isOffLot(donor.availability)) planned.info.push(`#${donor.machineNo} is ${donor.availability}, so no part is marked pulled there.`);
          else if (donor.bomStatus === "found" && !bomLookup(donor.bomParts, part.mpn)) planned.info.push(`${part.display} is not in #${donor.machineNo}'s parts list, so it is not marked pulled there.`);
          else planned.partStates.push({ machineNo: donor.machineNo, mpn: part.mpn, mpnDisplay: part.display, state: "pulled", note: `for #${no}` });
        }
      } else noteBits.push(sentence(label));
    }

    // Diagnosis: what is wrong, appended to what the record already says.
    const current = (fact.diagnosis ?? "").trim();
    const bits = [
      ...e.symptoms.map((k) => CARD_SYMPTOMS.find((s) => s.key === k)?.phrase ?? ""),
      sentence(e.problem),
      ...diagnosisBits
    ].filter((b) => b && !current.toLowerCase().includes(b.toLowerCase().replace(/\.$/, "")));
    const diagnosis = bits.length ? [current, ...new Set(bits)].filter(Boolean).join(" ") : null;

    // Repair notes: one dated line, the inventory's "5/12/26-…" style.
    const line: string[] = [];
    if (locationChanged) line.push(`Moved to ${nextLocation}${location && location !== "keep" && location.detail ? ` (${location.detail})` : ""}.`);
    if (statusChanged) line.push(`${statusLabel(target!)}.`);
    if (readyForClean && effectiveStatus !== "READY TO SALE") line.push("Ready for clean.");
    if (e.workDone) line.push(sentence(e.workDone));
    line.push(...noteBits);
    if (price && !sameMoney(price, fact.stickerPrice)) line.push(`Sticker $${Number(price).toFixed(2).replace(/\.00$/, "")}.`);
    if (e.note) line.push(sentence(e.note));
    const notesLine = line.length ? `${shortDate(date)}-${line.join(" ")}` : "";
    const currentNotes = (fact.notes ?? "").trim();
    const notes = notesLine ? [currentNotes, notesLine].filter(Boolean).join(" ") : null;

    const change = (field: FieldName, from: string | null, to: string | null) => {
      if (to != null && (from ?? "") !== to) planned.changes.push({ field, from, to });
    };
    if (statusChanged) change("availability", fact.availability, target);
    if (condition) change("condition", fact.condition, condition);
    if (locationChanged) change("location", fact.location, nextLocation);
    if (diagnosis) change("diagnosis", fact.diagnosis, diagnosis);
    if (notes) change("notes", fact.notes, notes);
    if (price && !sameMoney(price, fact.stickerPrice)) change("stickerPrice", fact.stickerPrice, price);
  }

  const unanswered = questions.filter((q) => q.answer == null).length;
  const hasChanges = entries.some((e) => e.changes.length || e.partStates.length);
  return {
    date,
    entries,
    questions,
    locationsToAdd: [...locationsToAdd].map(([name, aliases]) => ({ name, aliases: [...aliases] })),
    aliasesToAdd: [...aliasesToAdd.values()],
    unanswered,
    hasChanges,
    ready: unanswered === 0 && hasChanges
  };
}
