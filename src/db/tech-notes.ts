import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./types";
import { classifyFamily, suspectFamilies } from "@/src/lib/part-family";
import { modelKey } from "@/src/lib/model-key";
import { defaultDonorStatuses } from "@/src/lib/donor-status";
import {
  nearMachineNumbers, referencedMachineNumbers,
  type Answers, type BomPart, type MachineFact, type Observed, type Plan, type PlanFacts, type TrackedField
} from "@/src/lib/tech-notes/plan";
import { getSettings } from "./queries";
import { normalizeReading, type NoteReading } from "@/src/lib/tech-notes/reading";
import { SHOP_TIME_ZONE, shopToday } from "@/src/lib/tech-notes/vocabulary";

type Rows<T> = { rows: T[] };
async function q<T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as Rows<T>).rows;
}
/** A timestamp as the shop reads it: "2026-05-14 09:12" in shop time. */
const shopTime = (column: string) => sql.raw(`to_char(${column} at time zone '${SHOP_TIME_ZONE}', 'YYYY-MM-DD HH24:MI')`);
const shopDay = (column: string) => sql.raw(`to_char(${column} at time zone '${SHOP_TIME_ZONE}', 'YYYY-MM-DD')`);
/** A note's written date as a timestamp: the start of that day in shop time. */
const observedAt = (day: string) => sql`(${day}::date)::timestamp at time zone ${SHOP_TIME_ZONE}`;
const textArray = (values: string[]) => sql`${`{${values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`}::text[]`;

export type TechNoteStatus = "open" | "applied" | "discarded";
export type TechNote = {
  id: string;
  status: TechNoteStatus;
  origin: "photo" | "manual";
  card: string | null;
  hasPhoto: boolean;
  readerModel: string | null;
  readerError: string | null;
  reading: NoteReading | null;
  answers: Answers;
  appliedPlan: Plan | null;
  /** Date written on the note, once applied (YYYY-MM-DD). */
  observedOn: string | null;
  /** Shop day the note was uploaded (YYYY-MM-DD). */
  uploadedOn: string;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
};

/** Answers as posted by a browser: question id → value strings only, bounded. */
export function cleanAnswers(raw: unknown): Answers {
  const out: Answers = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
    if (typeof v === "string" && k.length <= 200) out[k] = v.slice(0, 300);
  }
  return out;
}

export async function createTechNote(db: Db, input: {
  origin: "photo" | "manual";
  photo?: { base64: string; type: string; sha256: string; bytes: number };
  reading?: NoteReading | null;
  readerModel?: string | null;
  readerError?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const p = input.photo;
  await db.execute(sql`
    insert into tech_notes (id, origin, card, photo_type, photo, photo_sha256, photo_bytes, reader_model, reader_error, reading)
    values (${id}::uuid, ${input.origin}, ${input.reading?.card ?? null},
      ${p?.type ?? null}, ${p ? sql`decode(${p.base64}, 'base64')` : null}, ${p?.sha256 ?? null}, ${p?.bytes ?? null},
      ${input.readerModel ?? null}, ${input.readerError ?? null}, ${input.reading ? JSON.stringify(input.reading) : null}::jsonb)`);
  return id;
}

export async function getTechNote(db: Db, id: string): Promise<TechNote | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await q<{
    id: string; status: TechNoteStatus; origin: "photo" | "manual"; card: string | null; has_photo: boolean;
    reader_model: string | null; reader_error: string | null; reading: unknown; answers: unknown; applied_plan: unknown;
    created_at: string; updated_at: string; applied_at: string | null; observed_on: string | null; uploaded_on: string;
  }>(db, sql`
    select id, status, origin, card, photo is not null has_photo, reader_model, reader_error, reading, answers, applied_plan,
      ${shopTime("created_at")} created_at, updated_at::text updated_at, ${shopTime("applied_at")} applied_at,
      observed_on::text observed_on, ${shopDay("created_at")} uploaded_on
    from tech_notes where id = ${id}::uuid`);
  if (!r) return null;
  const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    id: r.id, status: r.status, origin: r.origin, card: r.card, hasPhoto: r.has_photo, readerModel: r.reader_model, readerError: r.reader_error,
    reading: r.reading == null ? null : normalizeReading(json(r.reading)),
    answers: cleanAnswers(json(r.answers)),
    appliedPlan: r.applied_plan == null ? null : json(r.applied_plan) as Plan,
    observedOn: r.observed_on, uploadedOn: r.uploaded_on,
    createdAt: r.created_at, updatedAt: r.updated_at, appliedAt: r.applied_at
  };
}

export async function getTechNotePhoto(db: Db, id: string): Promise<{ type: string; bytes: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await q<{ photo_type: string; b64: string }>(db, sql`
    select photo_type, encode(photo, 'base64') b64 from tech_notes where id = ${id}::uuid and photo is not null`);
  return r ? { type: r.photo_type, bytes: Buffer.from(r.b64, "base64") } : null;
}

/** A new reading (re-read, or edits saved for later). Only while the note is open. */
export async function saveReading(db: Db, id: string, reading: NoteReading, reader?: { model: string | null; error: string | null }): Promise<boolean> {
  // A new read from the reader replaces the reading the saved answers were given against: they go.
  const rows = await q<{ id: string }>(db, sql`
    update tech_notes set reading = ${JSON.stringify(reading)}::jsonb, card = ${reading.card},
      answers = ${reader ? sql`'{}'::jsonb` : sql`answers`},
      reader_model = ${reader ? reader.model : sql`reader_model`}, reader_error = ${reader ? reader.error : sql`reader_error`}, updated_at = now()
    where id = ${id}::uuid and status = 'open' returning id`);
  return rows.length > 0;
}

/** Edits and answers kept for later (only while open). */
export async function saveDraft(db: Db, id: string, reading: NoteReading, answers: Answers): Promise<boolean> {
  const rows = await q<{ id: string }>(db, sql`
    update tech_notes set reading = ${JSON.stringify(reading)}::jsonb, answers = ${JSON.stringify(answers)}::jsonb, card = ${reading.card}, updated_at = now()
    where id = ${id}::uuid and status = 'open' returning id`);
  return rows.length > 0;
}

/** The newest note made from the same photo bytes, so one card is not applied twice. */
export async function findNoteByPhoto(db: Db, sha256: string): Promise<{ id: string; status: TechNoteStatus } | null> {
  const [r] = await q<{ id: string; status: TechNoteStatus }>(db, sql`
    select id, status from tech_notes where photo_sha256 = ${sha256} and status <> 'discarded' order by created_at desc limit 1`);
  return r ?? null;
}

export async function setReaderError(db: Db, id: string, error: string): Promise<void> {
  await db.execute(sql`update tech_notes set reader_error = ${error}, updated_at = now() where id = ${id}::uuid and status = 'open'`);
}

export async function discardTechNote(db: Db, id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(db, sql`
    update tech_notes set status = 'discarded', updated_at = now() where id = ${id}::uuid and status = 'open' returning id`);
  return rows.length > 0;
}

export type TechNoteListRow = {
  id: string; status: TechNoteStatus; origin: string; card: string | null; created_at: string; applied_at: string | null;
  /** Date written on the note: as applied, or as read. */
  written: string | null; machines: string[]; reader_error: string | null;
};
export async function listTechNotes(db: Db, limit = 30): Promise<TechNoteListRow[]> {
  const rows = await q<Omit<TechNoteListRow, "machines" | "written"> & { reading: unknown; observed_on: string | null }>(db, sql`
    select id, status, origin, card, ${shopTime("created_at")} created_at, ${shopTime("applied_at")} applied_at, reader_error, reading,
      observed_on::text observed_on
    from tech_notes order by tech_notes.created_at desc limit ${Math.max(1, Math.min(200, limit))}`);
  return rows.map(({ reading, observed_on, ...r }) => {
    const parsed = reading == null ? null : normalizeReading(typeof reading === "string" ? JSON.parse(reading) : reading);
    return {
      ...r, written: observed_on ?? (parsed?.date.text || null),
      machines: parsed ? parsed.entries.map((e) => e.machine.text.replace(/\D/g, "")).filter(Boolean) : []
    };
  });
}

// ---------------------------------------------------------------------------
// Facts for the planner
// ---------------------------------------------------------------------------
type MachineRow = {
  machine_no: string; availability: string; condition: string | null; location: string | null; diagnosis: string | null; notes: string | null;
  appliance_type: string; brand: string; brand_key: string; model_raw: string; model_key: string; serial: string; sticker_price: string | null;
  version: string; bom_status: string | null; last_epoch: number | null; last_day: string | null; last_label: string | null; open_check: boolean;
};
const MACHINE_SELECT = sql`
  select f.machine_no, f.availability, f.condition, f.location, f.diagnosis, f.notes, f.appliance_type, f.brand, f.brand_key,
    f.model_raw, f.model_key, f.serial, f.sticker_price::text sticker_price, f.updated_at::text version, c.status bom_status,
    extract(epoch from f.last_field_update_at)::float8 last_epoch, ${shopDay("f.last_field_update_at")} last_day,
    to_char(f.last_field_update_at at time zone ${SHOP_TIME_ZONE}, 'FMMM/FMDD/YY FMHH12:MI AM') last_label,
    exists (select 1 from fleet_location_checks lc where lc.machine_no = f.machine_no and lc.resolved_at is null) open_check
  from fleet_machines f
  left join model_bom_cache c on c.brand_key = f.brand_key and c.model_key = f.model_key`;

const SOURCE_LABEL: Record<string, string> = { tech_note: "tech note", fleet_ui: "Fleet edit", verified: "location check", part_state: "part record" };
type UpdateRow = {
  machine_no: string; key: string; epoch: number; day: string; date: string; time: string; source: string; state: string | null;
  /** For parts: machine_part_state.updated_at as text (the concurrency token on apply), null without a state row. */
  state_token: string | null;
};
const observed = (r: UpdateRow): Observed & { epoch: number } => ({
  day: r.day, epoch: r.epoch,
  // A tech note records a day, not a time.
  label: `on ${r.date}${r.source === "tech_note" ? "" : ` ${r.time}`} (${SOURCE_LABEL[r.source] ?? r.source})`
});

const toFact = (r: MachineRow, bomParts: BomPart[] = [], updates: UpdateRow[] = []): MachineFact => {
  const fieldUpdates: MachineFact["fieldUpdates"] = {};
  const partUpdates: MachineFact["partUpdates"] = {};
  let last: (Observed & { epoch: number }) | null = r.last_epoch != null && r.last_day
    ? { day: r.last_day, epoch: r.last_epoch, label: `on ${r.last_label}` } : null;
  for (const u of updates) {
    const o = observed(u);
    if (u.key.startsWith("part:")) partUpdates[u.key.slice(5)] = { day: o.day, label: o.label, state: u.state, token: u.state_token };
    else fieldUpdates[u.key as TrackedField] = { day: o.day, label: o.label };
    if (!last || o.epoch >= last.epoch) last = { ...o, label: `${o.label}, ${u.key.startsWith("part:") ? `part ${u.key.slice(5)}` : u.key === "availability" ? "status" : u.key === "stickerPrice" ? "sticker price" : u.key}` };
  }
  return {
    machineNo: r.machine_no, availability: r.availability, condition: r.condition, location: r.location, diagnosis: r.diagnosis, notes: r.notes,
    applianceType: r.appliance_type, brand: r.brand, modelRaw: r.model_raw, serial: r.serial, stickerPrice: r.sticker_price,
    version: r.version, bomStatus: r.bom_status, bomParts,
    lastUpdate: last ? { day: last.day, label: last.label } : null, fieldUpdates, partUpdates, openLocationCheck: r.open_check
  };
};

/**
 * The newest accepted decision per field and per part for these machines, newest first per key:
 * status changes, applied field changes (Fleet edits, tech notes, location checks), part states
 * and applied part decisions. History-only rows never count.
 */
async function latestUpdates(db: Db, machineNos: string[]): Promise<UpdateRow[]> {
  if (!machineNos.length) return [];
  const nos = textArray(machineNos);
  return q<UpdateRow>(db, sql`
    select distinct on (machine_no, key) machine_no, key, extract(epoch from at)::float8 epoch, state_token,
      to_char(at at time zone ${SHOP_TIME_ZONE}, 'YYYY-MM-DD') "day",
      to_char(at at time zone ${SHOP_TIME_ZONE}, 'FMMM/FMDD/YY') "date",
      to_char(at at time zone ${SHOP_TIME_ZONE}, 'FMHH12:MI AM') "time", source, state
    from (
      select machine_no, 'availability' key, coalesce(observed_at, changed_at) at, source, null::text state, null::text state_token
      from fleet_status_events where machine_no = any(${nos})
      union all
      select machine_no, 'availability', coalesce(observed_at, changed_at), source, null, null
      from fleet_field_events where field = 'status' and confirmation and machine_no = any(${nos})
      union all
      select machine_no, case field when 'sticker_price' then 'stickerPrice' else field end, coalesce(observed_at, changed_at), source, null, null
      from fleet_field_events where applied and field in ('condition','location','diagnosis','sticker_price') and machine_no = any(${nos})
      union all
      -- A physical check is a location decision even when it confirms the location already shown.
      select machine_no, 'location', resolved_at, 'verified', null, null
      from fleet_location_checks where resolved_at is not null and machine_no = any(${nos})
      union all
      select machine_no, 'part:' || mpn_canonical, coalesce(observed_at, updated_at), 'part_state', state, updated_at::text
      from machine_part_state where machine_no = any(${nos})
      union all
      select e.machine_no, 'part:' || e.mpn_canonical, e.observed_at, e.source, s.state, s.updated_at::text
      from fleet_part_events e
      left join machine_part_state s on s.machine_no = e.machine_no and s.mpn_canonical = e.mpn_canonical
      where e.applied and e.mpn_canonical is not null and e.machine_no = any(${nos})
    ) u
    order by machine_no, key, at desc`);
}

/**
 * Every record the planner may consult for this reading: the machines it names (with their
 * cached parts lists and newest decisions), machines one handwriting slip away from numbers
 * that do not exist, machines whose model matches a model written on the note, the location
 * list and the donor statuses.
 */
export async function loadPlanFacts(db: Db, reading: NoteReading, answers: Answers, now: Date = new Date(), uploadedOn?: string): Promise<PlanFacts> {
  const numbers = referencedMachineNumbers(reading, answers).slice(0, 60);
  const direct = numbers.length ? await q<MachineRow>(db, sql`${MACHINE_SELECT} where f.machine_no = any(${textArray(numbers)})`) : [];
  const found = new Set(direct.map((r) => r.machine_no));
  const near = [...new Set(numbers.filter((n) => !found.has(n)).flatMap(nearMachineNumbers))].slice(0, 1200);
  const models = [...new Set(reading.entries.map((e) => modelKey(e.model)).filter(Boolean))];
  const extra = near.length || models.length ? await q<MachineRow>(db, sql`${MACHINE_SELECT}
    where (f.machine_no = any(${textArray(near)}) or f.model_key = any(${textArray(models)}))
    order by f.machine_no limit 200`) : [];

  const withBom = direct.filter((r) => r.bom_status === "found");
  const edges = withBom.length ? await q<{ brand_key: string; model_key: string; mpn_canonical: string; mpn_display: string; description: string; part_family: string | null }>(db, sql`
    select e.brand_key, e.model_key, e.mpn_canonical, e.mpn_display, coalesce(nullif(e.description, ''), m.description, '') description, m.part_family
    from model_part_edges e
    join unnest(${textArray(withBom.map((r) => r.brand_key))}, ${textArray(withBom.map((r) => r.model_key))}) k(b, m2)
      on e.brand_key = k.b and e.model_key = k.m2
    left join mpn_master m on m.mpn_canonical = e.mpn_canonical
    order by e.mpn_canonical`) : [];
  const bomFor = new Map<string, BomPart[]>();
  for (const e of edges) {
    const key = `${e.brand_key}|${e.model_key}`;
    const list = bomFor.get(key) ?? [];
    if (!list.some((p) => p.mpn === e.mpn_canonical)) {
      list.push({ mpn: e.mpn_canonical, display: e.mpn_display, description: e.description, family: e.part_family && e.part_family !== "other" ? e.part_family : classifyFamily(e.description) });
    }
    bomFor.set(key, list);
  }
  const updates = await latestUpdates(db, direct.map((r) => r.machine_no));
  const machines: Record<string, MachineFact> = {};
  for (const r of extra) machines[r.machine_no] = toFact(r);
  for (const r of direct) machines[r.machine_no] = toFact(r, bomFor.get(`${r.brand_key}|${r.model_key}`) ?? [], updates.filter((u) => u.machine_no === r.machine_no));
  const settings = await getSettings(db);
  return {
    machines, locations: await locationList(db), today: shopToday(now), uploadedOn: uploadedOn ?? shopToday(now),
    donorStatuses: defaultDonorStatuses(settings.donorAvailabilities)
  };
}

export async function locationList(db: Db, onCardOnly = false): Promise<Array<{ name: string; aliases: string[] }>> {
  return q<{ name: string; aliases: string[] }>(db, sql`
    select name, aliases from fleet_locations ${onCardOnly ? sql`where on_card` : sql``} order by sort_order, name`);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
export type ApplyOutcome = "applied" | "conflict" | "not_open";
const FIELD_COLUMN = { availability: "status", condition: "condition", location: "location", diagnosis: "diagnosis", notes: "notes", stickerPrice: "sticker_price" } as const;

/**
 * Writes one planned note in a single SQL statement, so it all lands or none of it does.
 * Every machine being changed must still carry the version the plan was built from;
 * otherwise nothing is written and the caller reloads.
 *
 * What lands: applied field changes (with history rows dated by the note), history-only rows
 * for what an older date kept out, part decisions (failed, missing and removed also change
 * availability), test-first families, VERIFY LOCATION checks, last_field_update_at, new
 * locations and wordings, and the note itself with its written date.
 */
export async function applyTechNote(db: Db, id: string, plan: Plan, reading: NoteReading, answers: Answers): Promise<ApplyOutcome> {
  if (!plan.date) return "conflict";
  const live = plan.entries.filter((e) => e.fact && !e.skipped);
  const machines = live.filter((e) => e.changes.length || e.history.length || e.testFirst.length || e.confirmed.length).map((e) => {
    const f = e.fact!;
    const to = (field: string) => e.changes.find((c) => c.field === field);
    const diagnosis = to("diagnosis")?.to ?? f.diagnosis;
    const notes = to("notes")?.to ?? f.notes;
    const touchesText = Boolean(to("diagnosis") || to("notes"));
    const olderNote = e.history.length > 0 || e.parts.some((p) => !p.applied);
    // Status and location carry their own override flags (status_override, location_override from #31).
    const local = e.changes.flatMap((c) => (c.field === "availability" || c.field === "location" ? [] : [FIELD_COLUMN[c.field]]));
    // A confirmed value is note-set state too: it must survive the next workbook import like a change.
    const confirmed = new Set(e.confirmed.map((c) => c.field));
    if (confirmed.has("stickerPrice")) local.push("sticker_price");
    const decided = e.changes.some((c) => c.field !== "notes") || e.confirmed.length > 0 || e.parts.some((p) => p.applied && p.machineNo === f.machineNo);
    return {
      machine_no: f.machineNo,
      version: f.version,
      prev_availability: f.availability,
      set_availability: Boolean(to("availability")), availability: to("availability")?.to ?? f.availability,
      own_status: Boolean(to("availability")) || confirmed.has("availability"),
      own_location: Boolean(to("location")) || confirmed.has("location"),
      set_condition: Boolean(to("condition")), condition: to("condition")?.to ?? null,
      set_location: Boolean(to("location")), location: to("location")?.to ?? null,
      set_diagnosis: Boolean(to("diagnosis")), diagnosis: to("diagnosis")?.to ?? null,
      set_notes: Boolean(to("notes")), notes: to("notes")?.to ?? null,
      set_sticker: Boolean(to("stickerPrice")), sticker_price: to("stickerPrice")?.to ?? null,
      // Test-first flags only grow: text rules plus the families of suspected and needed parts.
      // An older note's line is history: its words do not flag anything (the notes before it do).
      families: [...new Set([...(touchesText ? suspectFamilies(diagnosis, olderNote ? f.notes : notes) : []), ...e.testFirst])],
      // Diagnosis and notes together drive part-family flags, so both stay local once either is set here.
      local_add: [...new Set(touchesText ? [...local, "diagnosis", "notes"] : local)],
      decided
    };
  });
  const inInput = new Set(machines.map((m) => m.machine_no));
  // Donors whose part a note marks removed, without any change of their own.
  const partOnly = [...new Set(live.flatMap((e) => e.parts.filter((p) => p.applied && !inInput.has(p.machineNo)).map((p) => p.machineNo)))];
  const events = live.flatMap((e) => [
    ...e.changes.filter((c) => c.field !== "availability").map((c) => ({ machine_no: e.fact!.machineNo, field: FIELD_COLUMN[c.field], prev: c.from, next: c.to, applied: true, confirmation: false })),
    ...e.history.map((c) => ({ machine_no: e.fact!.machineNo, field: FIELD_COLUMN[c.field], prev: c.from, next: c.to, applied: false, confirmation: false })),
    ...e.confirmed.map((c) => ({ machine_no: e.fact!.machineNo, field: FIELD_COLUMN[c.field], prev: c.to, next: c.to, applied: true, confirmation: true }))
  ]);
  // One row per machine and part (the planner already settled conflicts): a bulk upsert cannot touch a row twice.
  const parts = [...new Map(live.flatMap((e) => e.partStates).map((p) => [`${p.machineNo}|${p.mpn}`,
    { machine_no: p.machineNo, mpn: p.mpn, state: p.state, note: p.note, seen: p.seenToken ?? null }])).values()];
  const partEvents = live.flatMap((e) => e.parts.map((p) => ({
    machine_no: p.machineNo, mpn: p.mpn, display: p.mpnDisplay || null, name: p.name, kind: p.kind, other: p.otherMachine, applied: p.applied
  })));
  const checks = live.filter((e) => e.locationCheck).map((e) => ({ machine_no: e.fact!.machineNo, prev: e.locationCheck!.from, recorded: e.locationCheck!.to }));
  const obs = observedAt(plan.date);

  const [r] = await q<{ ok: boolean; updated: number }>(db, sql`
    with input as (
      select * from jsonb_to_recordset(${JSON.stringify(machines)}::jsonb) as m(
        machine_no text, version text, prev_availability text,
        set_availability boolean, availability text, set_condition boolean, condition text, set_location boolean, location text,
        set_diagnosis boolean, diagnosis text, set_notes boolean, notes text, set_sticker boolean, sticker_price text,
        families text[], local_add text[], decided boolean, own_status boolean, own_location boolean)
    ),
    locked as (
      select f.machine_no from fleet_machines f join input m on m.machine_no = f.machine_no
      where f.updated_at = m.version::timestamptz
      for update of f
    ),
    part_input as (
      select * from jsonb_to_recordset(${JSON.stringify(parts)}::jsonb) as p(machine_no text, mpn text, state text, note text, seen text)
    ),
    -- Part edits on the machine page do not move the machine's version: lock and check each part record
    -- this note writes. One changed since the plan (newer than the record seen, or than the note when
    -- there was none) stops the whole note, like a machine conflict.
    part_locked as (
      select s.machine_no, s.mpn_canonical, s.updated_at from machine_part_state s
      join part_input p on p.machine_no = s.machine_no and p.mpn = s.mpn_canonical
      for update of s
    ),
    ok as (
      select (select count(*) from locked) = (select count(*) from input)
        and not exists (
          select 1 from part_locked l join part_input p on p.machine_no = l.machine_no and p.mpn = l.mpn_canonical
          where l.updated_at > coalesce(p.seen::timestamptz, ${obs}))
        and exists (select 1 from tech_notes where id = ${id}::uuid and status = 'open') as ok
    ),
    upd as (
      update fleet_machines f set
        availability = case when m.set_availability then m.availability else f.availability end,
        status_override = f.status_override or m.own_status,
        condition = case when m.set_condition then m.condition else f.condition end,
        location = case when m.set_location then m.location else f.location end,
        location_override = f.location_override or m.own_location,
        diagnosis = case when m.set_diagnosis then m.diagnosis else f.diagnosis end,
        notes = case when m.set_notes then m.notes else f.notes end,
        sticker_price = case when m.set_sticker then m.sticker_price::numeric else f.sticker_price end,
        suspect_families = array(select distinct x from unnest(f.suspect_families || m.families) x order by x),
        local_fields = array(select distinct x from unnest(f.local_fields || m.local_add) x order by x),
        last_field_update_at = case when m.decided then greatest(f.last_field_update_at, ${obs}) else f.last_field_update_at end,
        updated_at = now()
      from input m, ok
      where ok.ok and f.machine_no = m.machine_no and f.machine_no in (select machine_no from locked)
      returning f.machine_no
    ),
    donors as (
      update fleet_machines f set last_field_update_at = greatest(f.last_field_update_at, ${obs})
      from ok
      where ok.ok and f.machine_no = any(${textArray(partOnly)})
      returning 1
    ),
    status_events as (
      insert into fleet_status_events (machine_no, previous_status, next_status, source, tech_note_id, observed_at)
      select m.machine_no, m.prev_availability, m.availability, 'tech_note', ${id}::uuid, ${obs}
      from input m join upd u on u.machine_no = m.machine_no
      where m.set_availability and m.prev_availability <> m.availability
      returning 1
    ),
    field_events as (
      insert into fleet_field_events (machine_no, field, previous_value, next_value, source, tech_note_id, observed_at, applied, confirmation)
      select e.machine_no, e.field, e.prev, e.next, 'tech_note', ${id}::uuid, ${obs}, e.applied, e.confirmation
      from jsonb_to_recordset(${JSON.stringify(events)}::jsonb) as e(machine_no text, field text, prev text, next text, applied boolean, confirmation boolean)
      join upd u on u.machine_no = e.machine_no
      where (e.prev is distinct from e.next) <> e.confirmation
      returning 1
    ),
    part_states as (
      insert into machine_part_state (machine_no, mpn_canonical, state, note, updated_at, observed_at)
      select p.machine_no, p.mpn, p.state, p.note, now(), ${obs}
      from part_input p, ok
      where ok.ok
      on conflict (machine_no, mpn_canonical) do update set state = excluded.state, note = excluded.note, updated_at = now(), observed_at = excluded.observed_at
        -- Only over the part record the reviewer saw (the planner already settled precedence, including a
        -- same-day "apply"), or over an older one when there was none: never over a record written since.
        where machine_part_state.updated_at <= coalesce(
          (select p2.seen::timestamptz from jsonb_to_recordset(${JSON.stringify(parts)}::jsonb) as p2(machine_no text, mpn text, seen text)
            where p2.machine_no = excluded.machine_no and p2.mpn = excluded.mpn_canonical),
          excluded.observed_at)
      returning 1
    ),
    part_events as (
      insert into fleet_part_events (machine_no, mpn_canonical, mpn_display, part_name, kind, other_machine, applied, tech_note_id, observed_at)
      select p.machine_no, p.mpn, p.display, coalesce(p.name, ''), p.kind, p.other, p.applied, ${id}::uuid, ${obs}
      from jsonb_to_recordset(${JSON.stringify(partEvents)}::jsonb) as p(machine_no text, mpn text, display text, name text, kind text, other text, applied boolean), ok
      where ok.ok
      returning 1
    ),
    location_checks as (
      insert into fleet_location_checks (machine_no, previous_location, recorded_location, tech_note_id, observed_at)
      select c.machine_no, c.prev, c.recorded, ${id}::uuid, ${obs}
      from jsonb_to_recordset(${JSON.stringify(checks)}::jsonb) as c(machine_no text, prev text, recorded text)
      join upd u on u.machine_no = c.machine_no
      returning 1
    ),
    new_locations as (
      insert into fleet_locations (name, aliases, source)
      select l.name, l.aliases, 'tech_note'
      from jsonb_to_recordset(${JSON.stringify(plan.locationsToAdd)}::jsonb) as l(name text, aliases text[]), ok
      where ok.ok
      on conflict (name) do update set aliases = array(select distinct x from unnest(fleet_locations.aliases || excluded.aliases) x order by x)
      returning 1
    ),
    new_aliases as (
      update fleet_locations fl set aliases = array(select distinct x from unnest(fl.aliases || a.aliases) x order by x)
      from (
        select name, array_agg(distinct alias) aliases
        from jsonb_to_recordset(${JSON.stringify(plan.aliasesToAdd)}::jsonb) as a(name text, alias text)
        group by name
      ) a, ok
      where ok.ok and fl.name = a.name
      returning 1
    ),
    note as (
      update tech_notes set status = 'applied', applied_at = now(), updated_at = now(), observed_on = ${plan.date}::date,
        reading = ${JSON.stringify(reading)}::jsonb, answers = ${JSON.stringify(answers)}::jsonb, applied_plan = ${JSON.stringify(plan)}::jsonb
      from ok
      where ok.ok and id = ${id}::uuid and status = 'open'
      returning 1
    )
    select (select ok from ok) ok, (select count(*)::int from upd) updated,
      (select count(*) from status_events) + (select count(*) from field_events) + (select count(*) from part_states) + (select count(*) from part_events)
      + (select count(*) from location_checks) + (select count(*) from donors)
      + (select count(*) from new_locations) + (select count(*) from new_aliases) + (select count(*) from note) touched`);
  if (r?.ok) return "applied";
  const [open] = await q<{ status: string }>(db, sql`select status from tech_notes where id = ${id}::uuid`);
  return open?.status === "open" ? "conflict" : "not_open";
}

// ---------------------------------------------------------------------------
// VERIFY LOCATION
// ---------------------------------------------------------------------------
export type LocationCheckRow = {
  id: number; previous_location: string | null; recorded_location: string; observed: string; created_at: string; tech_note_id: string | null;
};
/** Machines with an open VERIFY LOCATION check. */
export async function openLocationCheckCount(db: Db): Promise<number> {
  const [r] = await q<{ n: number }>(db, sql`select count(distinct machine_no)::int n from fleet_location_checks where resolved_at is null`);
  return r?.n ?? 0;
}
export async function openLocationChecks(db: Db, machineNo: string): Promise<LocationCheckRow[]> {
  return q<LocationCheckRow>(db, sql`
    select id::int id, previous_location, recorded_location, to_char(observed_at at time zone ${SHOP_TIME_ZONE}, 'FMMM/FMDD/YY') observed,
      ${shopTime("created_at")} created_at, tech_note_id::text tech_note_id
    from fleet_location_checks where machine_no = ${machineNo} and resolved_at is null order by created_at`);
}

/**
 * Someone went and looked: record where the machine physically is and close every open check.
 * The only way a VERIFY LOCATION alert clears. One statement.
 */
export async function verifyLocation(db: Db, input: { machineNo: string; location: string }): Promise<"verified" | "invalid" | "no_open_check"> {
  const location = input.location.trim();
  // eslint-disable-next-line no-control-regex
  if (!input.machineNo || !location || location.length > 120 || /[\u0000-\u001F\u007F]/.test(location)) return "invalid";
  const [r] = await q<{ resolved: number }>(db, sql`
    with open_checks as (
      select id from fleet_location_checks where machine_no = ${input.machineNo} and resolved_at is null for update
    ),
    cur as (
      select machine_no, location from fleet_machines where machine_no = ${input.machineNo} and exists (select 1 from open_checks) for update
    ),
    upd as (
      update fleet_machines f set location = ${location}, location_override = true,
        last_field_update_at = greatest(f.last_field_update_at, now()), updated_at = now()
      from cur where f.machine_no = cur.machine_no
      returning f.machine_no, cur.location previous
    ),
    logged as (
      insert into fleet_field_events (machine_no, field, previous_value, next_value, source, observed_at)
      select machine_no, 'location', previous, ${location}, 'verified', now() from upd where previous is distinct from ${location}
      returning 1
    ),
    listed as (
      insert into fleet_locations (name, source) select ${location}, 'verified' from upd on conflict (name) do nothing returning 1
    ),
    resolved as (
      update fleet_location_checks set resolved_at = now(), resolved_location = ${location}
      where id in (select id from open_checks) and exists (select 1 from upd)
      returning 1
    )
    select (select count(*)::int from resolved) resolved, (select count(*) from logged) + (select count(*) from listed) touched`);
  return r && r.resolved > 0 ? "verified" : "no_open_check";
}

// ---------------------------------------------------------------------------
// History shown on the machine page
// ---------------------------------------------------------------------------
export type HistoryRow = {
  changed_at: string; observed: string | null; field: string; previous_value: string | null; next_value: string | null;
  source: string; tech_note_id: string | null; applied: boolean;
};
export async function machineHistory(db: Db, machineNo: string, limit = 60): Promise<HistoryRow[]> {
  const day = (col: string) => sql.raw(`to_char(${col} at time zone '${SHOP_TIME_ZONE}', 'FMMM/FMDD/YY')`);
  // Rows written by one statement share a timestamp: a check or its resolution reads after the change it explains.
  return q<HistoryRow>(db, sql`
    select changed_at, observed, field, previous_value, next_value, source, tech_note_id, applied from (
      select ${shopTime("changed_at")} changed_at, ${day("observed_at")} observed, 'status' field, previous_status previous_value, next_status next_value,
        source, tech_note_id::text tech_note_id, true applied, changed_at sort, 1 rank
      from fleet_status_events where machine_no = ${machineNo}
      union all
      select ${shopTime("changed_at")}, ${day("observed_at")}, case when confirmation then field || ' confirmed' else field end,
        previous_value, next_value, source, tech_note_id::text, applied, changed_at, 1
      from fleet_field_events where machine_no = ${machineNo}
      union all
      select ${shopTime("created_at")}, ${day("observed_at")}, 'part ' || kind, null, trim(both ' ' from coalesce(part_name, '') || ' ' || coalesce(mpn_display, '')),
        source, tech_note_id::text, applied, created_at, 2
      from fleet_part_events where machine_no = ${machineNo}
      union all
      select ${shopTime("created_at")}, ${day("observed_at")}, 'VERIFY LOCATION raised', previous_location, recorded_location, 'tech_note', tech_note_id::text, true, created_at, 3
      from fleet_location_checks where machine_no = ${machineNo}
      union all
      select ${shopTime("resolved_at")}, null, 'location verified', null, resolved_location, 'verified', null, true, resolved_at, 4
      from fleet_location_checks where machine_no = ${machineNo} and resolved_at is not null
    ) h order by sort desc, rank desc limit ${limit}`);
}
