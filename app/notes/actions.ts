"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/src/db";
import {
  applyTechNote, cleanAnswers, createTechNote, discardTechNote, findNoteByPhoto, getTechNote, getTechNotePhoto,
  loadPlanFacts, locationList, saveDraft, saveReading, setReaderError
} from "@/src/db/tech-notes";
import { planNote, type PlanFacts } from "@/src/lib/tech-notes/plan";
import { emptyReading, normalizeReading } from "@/src/lib/tech-notes/reading";
import { readCard, readerConfig, ReaderError } from "@/src/lib/tech-notes/reader";
import type { ActionResult } from "../actions";

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const UNREADABLE = "The card could not be read this time. Re-read, retake the photo, or type the card.";

const parseJson = (v: FormDataEntryValue | null): unknown => {
  try { return JSON.parse(String(v ?? "")); } catch { return null; }
};

/** Photo in → note with its reading out. Opens the note so its questions can be answered. */
export async function readCardAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Take or choose a photo of the card first." };
  if (file.size > MAX_PHOTO_BYTES) return { ok: false, message: `That photo is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB. Retake it closer to the card.` };
  if (!PHOTO_TYPES.includes(file.type)) return { ok: false, message: "Use a JPEG, PNG, WebP or HEIC photo." };
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const db = await getDb();
  const earlier = await findNoteByPhoto(db, sha256);
  if (earlier) redirect(`/notes/${earlier.id}?dup=1`);

  const base64 = bytes.toString("base64");
  const cfg = readerConfig();
  let reading = emptyReading();
  let model: string | null = null;
  let error: string | null = null;
  if (!cfg) error = "The card reader is not set up (GEMINI_API_KEY is missing). Type what the card says below.";
  else {
    try {
      const r = await readCard(cfg, { base64, mimeType: file.type }, (await locationList(db)).map((l) => l.name), "quick");
      reading = r.reading;
      model = r.model;
    } catch (e) {
      error = e instanceof ReaderError ? e.message : UNREADABLE;
    }
  }
  const id = await createTechNote(db, { origin: "photo", photo: { base64, type: file.type, sha256, bytes: bytes.length }, reading, readerModel: model, readerError: error });
  revalidatePath("/notes");
  redirect(`/notes/${id}`);
}

/** A note typed by hand: the same questions and checks, without a photo. */
export async function startTypedNoteAction(): Promise<void> {
  const id = await createTechNote(await getDb(), { origin: "manual", reading: emptyReading() });
  revalidatePath("/notes");
  redirect(`/notes/${id}`);
}

/** Records the review page needs for the reading and answers as they stand. */
export async function loadFactsAction(id: string, reading: unknown, answers: unknown): Promise<PlanFacts> {
  const db = await getDb();
  const note = await getTechNote(db, id);
  return loadPlanFacts(db, normalizeReading(reading), cleanAnswers(answers), new Date(), note?.uploadedOn);
}

export async function saveDraftAction(id: string, reading: unknown, answers: unknown): Promise<ActionResult> {
  const saved = await saveDraft(await getDb(), id, normalizeReading(reading), cleanAnswers(answers));
  return saved ? { ok: true, message: "Saved. Come back to it from Tech notes." } : { ok: false, message: "This note is no longer open." };
}

export async function rereadNoteAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = String(form.get("id") ?? "");
  const db = await getDb();
  const note = await getTechNote(db, id);
  if (!note || note.status !== "open") return { ok: false, message: "This note is no longer open." };
  const photo = await getTechNotePhoto(db, id);
  if (!photo) return { ok: false, message: "This note has no photo to read." };
  const cfg = readerConfig();
  if (!cfg) return { ok: false, message: "The card reader is not set up (GEMINI_API_KEY is missing)." };
  try {
    const r = await readCard(cfg, { base64: photo.bytes.toString("base64"), mimeType: photo.type }, (await locationList(db)).map((l) => l.name), "careful");
    await saveReading(db, id, r.reading, { model: r.model, error: null });
  } catch (e) {
    const message = e instanceof ReaderError ? e.message : UNREADABLE;
    await setReaderError(db, id, message);
    return { ok: false, message };
  }
  revalidatePath(`/notes/${id}`);
  return { ok: true, message: "Read again carefully. Check the questions and changes." };
}

/** Recomputes the plan from the posted reading and answers with fresh records, then writes it all or nothing. */
export async function applyNoteAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = String(form.get("id") ?? "");
  const reading = normalizeReading(parseJson(form.get("reading")));
  const answers = cleanAnswers(parseJson(form.get("answers")));
  const seen = cleanAnswers(parseJson(form.get("versions")));
  const db = await getDb();
  const note = await getTechNote(db, id);
  if (!note || note.status !== "open") return { ok: false, message: "This note was already applied or discarded." };
  const plan = planNote(reading, await loadPlanFacts(db, reading, answers, new Date(), note.uploadedOn), answers);
  if (plan.unanswered) return { ok: false, message: `Answer the ${plan.unanswered === 1 ? "last question" : `${plan.unanswered} remaining questions`} first.` };
  if (!plan.hasChanges) return { ok: false, message: "Nothing on this note changes a machine. Edit the reading, or discard the note." };
  const changed = plan.entries.filter((e) => e.fact && (e.changes.length || e.history.length) && seen[e.fact.machineNo] !== e.fact.version);
  if (changed.length) {
    await saveDraft(db, id, reading, answers);
    return { ok: false, message: `${changed.map((e) => `#${e.machineNo}`).join(", ")} changed since this page opened. Your answers are saved: reload to check the current record.` };
  }
  const outcome = await applyTechNote(db, id, plan, reading, answers);
  if (outcome === "not_open") return { ok: false, message: "This note was already applied or discarded." };
  if (outcome === "conflict") {
    await saveDraft(db, id, reading, answers);
    return { ok: false, message: "A machine changed while saving, so nothing was saved. Your answers are kept: reload and apply again." };
  }
  revalidatePath("/", "layout");
  redirect(`/notes/${id}`);
}

export async function discardNoteAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = String(form.get("id") ?? "");
  if (!(await discardTechNote(await getDb(), id))) return { ok: false, message: "This note is no longer open." };
  revalidatePath("/notes");
  redirect("/notes");
}
