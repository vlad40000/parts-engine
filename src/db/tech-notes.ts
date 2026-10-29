import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./types";
import { suspectFamilies } from "@/src/lib/part-family";
import { modelKey } from "@/src/lib/model-key";
import { nearMachineNumbers, referencedMachineNumbers, type Answers, type BomPart, type MachineFact, type Plan, type PlanFacts } from "@/src/lib/tech-notes/plan";
import { normalizeReading, type NoteReading } from "@/src/lib/tech-notes/reading";
import { SHOP_TIME_ZONE, shopToday } from "@/src/lib/tech-notes/vocabulary";

type Rows<T> = { rows: T[] };
async function q<T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as Rows<T>).rows;
}
/** A timestamp as the shop reads it: "2026-05-14 09:12" in shop time. */
const shopTime = (column: string) => sql.raw(`to_char(${column} at time zone '${SHOP_TIME_ZONE}', 'YYYY-MM-DD HH24:MI')`);
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
    created_at: string; updated_at: string; applied_at: string | null;
  }>(db, sql`
    select id, status, origin, card, photo is not null has_photo, reader_model, reader_error, reading, answers, applied_plan,
      ${shopTime("created_at")} created_at, updated_at::text updated_at, ${shopTime("applied_at")} applied_at
    from tech_notes where id = ${id}::uuid`);
  if (!r) return null;
  const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    id: r.id, status: r.status, origin: r.origin, card: r.card, hasPhoto: r.has_photo, readerModel: r.reader_model, readerError: r.reader_error,
    reading: r.reading == null ? null : normalizeReading(json(r.reading)),
    answers: cleanAnswers(json(r.answers)),
    appliedPlan: r.applied_plan == null ? null : json(r.applied_plan) as Plan,
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
  const rows = await q<{ id: string }>(db, sql`
    update tech_notes set reading = ${JSON.stringify(reading)}::jsonb, card = ${reading.card},
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

export type TechNoteListRow = { id: string; status: TechNoteStatus; origin: string; card: string | null; created_at: string; applied_at: string | null; machines: string[]; reader_error: string | null };
export async function listTechNotes(db: Db, limit = 30): Promise<TechNoteListRow[]> {
  const rows = await q<Omit<TechNoteListRow, "machines"> & { reading: unknown }>(db, sql`
    select id, status, origin, card, ${shopTime("created_at")} created_at, ${shopTime("applied_at")} applied_at, reader_error, reading
    from tech_notes order by tech_notes.created_at desc limit ${Math.max(1, Math.min(200, limit))}`);
  return rows.map(({ reading, ...r }) => {
    const parsed = reading == null ? null : normalizeReading(typeof reading === "string" ? JSON.parse(reading) : reading);
    return { ...r, machines: parsed ? parsed.entries.map((e) => e.machine.text.replace(/\D/g, "")).filter(Boolean) : [] };
  });
}

// ---------------------------------------------------------------------------
// Facts for the planner
// ---------------------------------------------------------------------------
type MachineRow = {
  machine_no: string; availability: string; condition: string | null; location: string | null; diagnosis: string | null; notes: string | null;
  appliance_type: string; brand: string; brand_key: string; model_raw: string; model_key: string; serial: string; sticker_price: string | null;
  version: string; bom_status: string | null;
};
const MACHINE_SELECT = sql`
  select f.machine_no, f.availability, f.condition, f.location, f.diagnosis, f.notes, f.appliance_type, f.brand, f.brand_key,
    f.model_raw, f.model_key, f.serial, f.sticker_price::text sticker_price, f.updated_at::text version, c.status bom_status
  from fleet_machines f
  left join model_bom_cache c on c.brand_key = f.brand_key and c.model_key = f.model_key`;

const toFact = (r: MachineRow, bomParts: BomPart[] = []): MachineFact => ({
  machineNo: r.machine_no, availability: r.availability, condition: r.condition, location: r.location, diagnosis: r.diagnosis, notes: r.notes,
  applianceType: r.appliance_type, brand: r.brand, modelRaw: r.model_raw, serial: r.serial, stickerPrice: r.sticker_price,
  version: r.version, bomStatus: r.bom_status, bomParts
});

/**
 * Every record the planner may consult for this reading: the machines it names (with their
 * cached parts lists), machines one handwriting slip away from numbers that do not exist,
 * machines whose model matches a model written on the note, and the location list.
 */
export async function loadPlanFacts(db: Db, reading: NoteReading, answers: Answers, now: Date = new Date()): Promise<PlanFacts> {
  const numbers = referencedMachineNumbers(reading, answers).slice(0, 60);
  const direct = numbers.length ? await q<MachineRow>(db, sql`${MACHINE_SELECT} where f.machine_no = any(${textArray(numbers)})`) : [];
  const found = new Set(direct.map((r) => r.machine_no));
  const near = [...new Set(numbers.filter((n) => !found.has(n)).flatMap(nearMachineNumbers))].slice(0, 1200);
  const models = [...new Set(reading.entries.map((e) => modelKey(e.model)).filter(Boolean))];
  const extra = near.length || models.length ? await q<MachineRow>(db, sql`${MACHINE_SELECT}
    where (f.machine_no = any(${textArray(near)}) or f.model_key = any(${textArray(models)}))
    order by f.machine_no limit 200`) : [];

  const withBom = direct.filter((r) => r.bom_status === "found");
  const edges = withBom.length ? await q<{ brand_key: string; model_key: string; mpn_canonical: string; mpn_display: string; description: string }>(db, sql`
    select e.brand_key, e.model_key, e.mpn_canonical, e.mpn_display, coalesce(nullif(e.description, ''), m.description, '') description
    from model_part_edges e
    join unnest(${textArray(withBom.map((r) => r.brand_key))}, ${textArray(withBom.map((r) => r.model_key))}) k(b, m2)
      on e.brand_key = k.b and e.model_key = k.m2
    left join mpn_master m on m.mpn_canonical = e.mpn_canonical
    order by e.mpn_canonical`) : [];
  const bomFor = new Map<string, BomPart[]>();
  for (const e of edges) {
    const key = `${e.brand_key}|${e.model_key}`;
    const list = bomFor.get(key) ?? [];
    if (!list.some((p) => p.mpn === e.mpn_canonical)) list.push({ mpn: e.mpn_canonical, display: e.mpn_display, description: e.description });
    bomFor.set(key, list);
  }
  const machines: Record<string, MachineFact> = {};
  for (const r of extra) machines[r.machine_no] = toFact(r);
  for (const r of direct) machines[r.machine_no] = toFact(r, bomFor.get(`${r.brand_key}|${r.model_key}`) ?? []);
  return { machines, locations: await locationList(db), today: shopToday(now) };
}

export async function locationList(db: Db, onCardOnly = false): Promise<Array<{ name: string; aliases: string[] }>> {
  return q<{ name: string; aliases: string[] }>(db, sql`
    select name, aliases from fleet_locations ${onCardOnly ? sql`where on_card` : sql``} order by sort_order, name`);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
export type ApplyOutcome = "applied" | "conflict" | "not_open";
const FIELD_COLUMN = { condition: "condition", location: "location", diagnosis: "diagnosis", notes: "notes", stickerPrice: "sticker_price" } as const;

/**
 * Writes one planned note in a single SQL statement, so it all lands or none of it does.
 * Every machine being changed must still carry the version the plan was built from;
 * otherwise nothing is written and the caller reloads.
 */
export async function applyTechNote(db: Db, id: string, plan: Plan, reading: NoteReading, answers: Answers): Promise<ApplyOutcome> {
  const machines = plan.entries.filter((e) => e.fact && !e.skipped && e.changes.length).map((e) => {
    const f = e.fact!;
    const to = (field: string) => e.changes.find((c) => c.field === field);
    const diagnosis = to("diagnosis")?.to ?? f.diagnosis;
    const notes = to("notes")?.to ?? f.notes;
    const touchesText = Boolean(to("diagnosis") || to("notes"));
    // Status and location carry their own override flags (status_override, location_override from #31).
    const local = e.changes.flatMap((c) => (c.field === "availability" || c.field === "location" ? [] : [FIELD_COLUMN[c.field]]));
    return {
      machine_no: f.machineNo,
      version: f.version,
      prev_availability: f.availability,
      set_availability: Boolean(to("availability")), availability: to("availability")?.to ?? f.availability,
      set_condition: Boolean(to("condition")), condition: to("condition")?.to ?? null,
      set_location: Boolean(to("location")), location: to("location")?.to ?? null,
      set_diagnosis: Boolean(to("diagnosis")), diagnosis: to("diagnosis")?.to ?? null,
      set_notes: Boolean(to("notes")), notes: to("notes")?.to ?? null,
      set_sticker: Boolean(to("stickerPrice")), sticker_price: to("stickerPrice")?.to ?? null,
      set_families: touchesText,
      families: touchesText ? suspectFamilies(diagnosis, notes) : [],
      // Diagnosis and notes together drive part-family flags, so both stay local once either is set here.
      local_add: [...new Set(touchesText ? [...local, "diagnosis", "notes"] : local)]
    };
  });
  const events = plan.entries.filter((e) => e.fact && !e.skipped).flatMap((e) => e.changes
    .filter((c) => c.field !== "availability")
    .map((c) => ({ machine_no: e.fact!.machineNo, field: FIELD_COLUMN[c.field as keyof typeof FIELD_COLUMN], prev: c.from, next: c.to })));
  const parts = plan.entries.filter((e) => !e.skipped).flatMap((e) => e.partStates.map((p) => ({ machine_no: p.machineNo, mpn: p.mpn, state: p.state, note: p.note })));

  const [r] = await q<{ ok: boolean; updated: number }>(db, sql`
    with input as (
      select * from jsonb_to_recordset(${JSON.stringify(machines)}::jsonb) as m(
        machine_no text, version text, prev_availability text,
        set_availability boolean, availability text, set_condition boolean, condition text, set_location boolean, location text,
        set_diagnosis boolean, diagnosis text, set_notes boolean, notes text, set_sticker boolean, sticker_price text,
        set_families boolean, families text[], local_add text[])
    ),
    locked as (
      select f.machine_no from fleet_machines f join input m on m.machine_no = f.machine_no
      where f.updated_at = m.version::timestamptz
      for update of f
    ),
    ok as (
      select (select count(*) from locked) = (select count(*) from input)
        and exists (select 1 from tech_notes where id = ${id}::uuid and status = 'open') as ok
    ),
    upd as (
      update fleet_machines f set
        availability = case when m.set_availability then m.availability else f.availability end,
        status_override = f.status_override or m.set_availability,
        condition = case when m.set_condition then m.condition else f.condition end,
        location = case when m.set_location then m.location else f.location end,
        location_override = f.location_override or m.set_location,
        diagnosis = case when m.set_diagnosis then m.diagnosis else f.diagnosis end,
        notes = case when m.set_notes then m.notes else f.notes end,
        sticker_price = case when m.set_sticker then m.sticker_price::numeric else f.sticker_price end,
        suspect_families = case when m.set_families then m.families else f.suspect_families end,
        local_fields = array(select distinct x from unnest(f.local_fields || m.local_add) x order by x),
        updated_at = now()
      from input m, ok
      where ok.ok and f.machine_no = m.machine_no and f.machine_no in (select machine_no from locked)
      returning f.machine_no
    ),
    status_events as (
      insert into fleet_status_events (machine_no, previous_status, next_status, source, tech_note_id)
      select m.machine_no, m.prev_availability, m.availability, 'tech_note', ${id}::uuid
      from input m join upd u on u.machine_no = m.machine_no
      where m.set_availability and m.prev_availability <> m.availability
      returning 1
    ),
    field_events as (
      insert into fleet_field_events (machine_no, field, previous_value, next_value, source, tech_note_id)
      select e.machine_no, e.field, e.prev, e.next, 'tech_note', ${id}::uuid
      from jsonb_to_recordset(${JSON.stringify(events)}::jsonb) as e(machine_no text, field text, prev text, next text)
      join upd u on u.machine_no = e.machine_no
      where e.prev is distinct from e.next
      returning 1
    ),
    part_states as (
      insert into machine_part_state (machine_no, mpn_canonical, state, note, updated_at)
      select p.machine_no, p.mpn, p.state, p.note, now()
      from jsonb_to_recordset(${JSON.stringify(parts)}::jsonb) as p(machine_no text, mpn text, state text, note text), ok
      where ok.ok
      on conflict (machine_no, mpn_canonical) do update set state = excluded.state, note = excluded.note, updated_at = now()
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
      update tech_notes set status = 'applied', applied_at = now(), updated_at = now(),
        reading = ${JSON.stringify(reading)}::jsonb, answers = ${JSON.stringify(answers)}::jsonb, applied_plan = ${JSON.stringify(plan)}::jsonb
      from ok
      where ok.ok and id = ${id}::uuid and status = 'open'
      returning 1
    )
    select (select ok from ok) ok, (select count(*)::int from upd) updated,
      (select count(*) from status_events) + (select count(*) from field_events) + (select count(*) from part_states)
      + (select count(*) from new_locations) + (select count(*) from new_aliases) + (select count(*) from note) touched`);
  if (r?.ok) return "applied";
  const [open] = await q<{ status: string }>(db, sql`select status from tech_notes where id = ${id}::uuid`);
  return open?.status === "open" ? "conflict" : "not_open";
}

// ---------------------------------------------------------------------------
// History shown on the machine page
// ---------------------------------------------------------------------------
export type HistoryRow = { changed_at: string; field: string; previous_value: string | null; next_value: string | null; source: string; tech_note_id: string | null };
export async function machineHistory(db: Db, machineNo: string, limit = 40): Promise<HistoryRow[]> {
  return q<HistoryRow>(db, sql`
    select * from (
      select ${shopTime("changed_at")} changed_at, 'status' field, previous_status previous_value, next_status next_value, source, tech_note_id::text tech_note_id, changed_at sort
      from fleet_status_events where machine_no = ${machineNo}
      union all
      select ${shopTime("changed_at")}, field, previous_value, next_value, source, tech_note_id::text, changed_at
      from fleet_field_events where machine_no = ${machineNo}
    ) h order by sort desc limit ${limit}`);
}
