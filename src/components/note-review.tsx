"use client";

import { startTransition, useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/app/actions";
import {
  FIELD_LABEL as FIELD_WORD, PART_KIND_LABEL, planNote, referencedMachineNumbers, machineSummary,
  type Answers, type FieldChange, type Plan, type PlanFacts, type PlannedEntry, type Question
} from "@/src/lib/tech-notes/plan";
import { emptyEntry, emptyPart, PART_ACTIONS, type NoteReading, type ReadEntry, type ReadPart } from "@/src/lib/tech-notes/reading";
import { CARD_NAMES, CARD_SYMPTOMS, NOTE_STATUSES, SALE_GRADES, shortDate } from "@/src/lib/tech-notes/vocabulary";

type Action = (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
export type NoteReviewProps = {
  noteId: string;
  origin: "photo" | "manual";
  hasPhoto: boolean;
  readerModel: string | null;
  readerError: string | null;
  createdAt: string;
  duplicate: boolean;
  canReread: boolean;
  initialReading: NoteReading;
  initialAnswers: Answers;
  initialFacts: PlanFacts;
  applyAction: Action;
  rereadAction: Action;
  discardAction: Action;
  saveDraftAction: (id: string, reading: unknown, answers: unknown) => Promise<ActionResult>;
  loadFactsAction: (id: string, reading: unknown, answers: unknown) => Promise<PlanFacts>;
};

const FIELD_LABEL: Record<FieldChange["field"], string> = {
  availability: "Status", condition: "Condition", location: "Location", diagnosis: "Diagnosis", notes: "Repair notes", stickerPrice: "Sticker price"
};
const factsKey = (reading: NoteReading, answers: Answers) =>
  JSON.stringify([referencedMachineNumbers(reading, answers).sort(), reading.entries.map((e) => e.model.trim().toUpperCase()).filter(Boolean).sort()]);

export function NoteReview(p: NoteReviewProps) {
  const [reading, setReading] = useState(p.initialReading);
  const [answers, setAnswers] = useState<Answers>(p.initialAnswers);
  const [facts, setFacts] = useState(p.initialFacts);
  const [loadingFacts, setLoadingFacts] = useState(false);
  const loadedKey = useRef(factsKey(p.initialReading, p.initialAnswers));
  const plan = useMemo(() => planNote(reading, facts, answers), [reading, facts, answers]);

  // Fetch records when the note starts pointing at machines this page has not loaded.
  const wanted = factsKey(reading, answers);
  useEffect(() => {
    if (wanted === loadedKey.current) return;
    let live = true;
    const timer = setTimeout(async () => {
      setLoadingFacts(true);
      try {
        const next = await p.loadFactsAction(p.noteId, reading, answers);
        if (live) { setFacts(next); loadedKey.current = wanted; }
      } finally {
        if (live) setLoadingFacts(false);
      }
    }, 350);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  const setAnswer = (id: string, value: string | null) => setAnswers((a) => {
    const next = { ...a };
    if (value == null) delete next[id]; else next[id] = value;
    return next;
  });
  const editorOpen = p.origin === "manual" || Boolean(p.readerError) || reading.entries.every((e) => !e.machine.text);
  const open = plan.questions.filter((q) => q.answer == null);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
        {p.hasPhoto ? (
          <a href={`/notes/${p.noteId}/photo`} target="_blank" rel="noreferrer" className="card block overflow-hidden" title="Open the full photo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/notes/${p.noteId}/photo`} alt="Photo of the tech note" className="max-h-[45vh] w-full object-contain lg:max-h-[70vh]" />
          </a>
        ) : <div className="card p-4 text-sm text-muted">Typed note: no photo.</div>}
        <div className="text-xs text-muted">
          {CARD_NAMES[reading.card]} · {p.origin === "photo" ? `read ${p.readerModel ? `by ${p.readerModel}` : "without the card reader"}` : "typed by hand"}
          <br />Written {plan.date ? shortDate(plan.date) : "(date not settled)"} · uploaded {p.createdAt}
        </div>
        <div className="flex flex-wrap gap-2">
          {p.canReread ? <ActionButton action={p.rereadAction} noteId={p.noteId} label="Re-read carefully" pendingLabel="Reading carefully…" /> : null}
          <DiscardButton action={p.discardAction} noteId={p.noteId} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col gap-5">
        {p.duplicate ? <Banner tone="wait">This photo was uploaded before. This is the note made from it, so the card is not applied twice.</Banner> : null}
        {p.readerError ? <Banner tone="stop">{p.readerError}</Banner> : null}

        <section>
          <h2 className="mb-2 font-semibold">
            {plan.questions.length ? (open.length ? `${open.length} question${open.length === 1 ? "" : "s"} before saving` : "All questions answered") : "No questions"}
            {loadingFacts ? <span className="ml-2 text-xs font-normal text-muted">Checking machine records…</span> : null}
          </h2>
          {reading.unreadable.length ? <Banner tone="wait">The reader could not read: {reading.unreadable.join("; ")}. Fix the reading below if it matters.</Banner> : null}
          <div className="flex flex-col gap-3">
            {plan.questions.map((q) => <QuestionCard key={q.id} q={q} checking={wanted !== loadedKey.current} onAnswer={(v) => setAnswer(q.id, v)} />)}
          </div>
          {!plan.questions.length ? <p className="text-sm text-muted">Nothing on this note needs an answer.</p> : null}
        </section>

        <section>
          <h2 className="mb-2 font-semibold">What will change</h2>
          <div className="flex flex-col gap-3">
            {plan.entries.map((e) => <EntryChanges key={e.key} e={e} />)}
          </div>
          {plan.locationsToAdd.length ? <p className="mt-2 text-sm">New location{plan.locationsToAdd.length > 1 ? "s" : ""} for the location list: {plan.locationsToAdd.map((l) => l.name).join(", ")}.</p> : null}
          {plan.aliasesToAdd.length ? <p className="mt-1 text-xs text-muted">Remembered wording: {plan.aliasesToAdd.map((a) => `"${a.alias}" = ${a.name}`).join(", ")}.</p> : null}
        </section>

        <details className="card p-4" open={editorOpen}>
          <summary className="cursor-pointer font-semibold">What the card says <span className="text-xs font-normal text-muted">(fix a misread here)</span></summary>
          <ReadingEditor reading={reading} onChange={setReading} locations={facts.locations.map((l) => l.name)} />
        </details>

        <ApplyBar noteId={p.noteId} plan={plan} reading={reading} answers={answers} facts={facts} applyAction={p.applyAction} saveDraftAction={p.saveDraftAction} />
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "wait" | "stop" | "go"; children: React.ReactNode }) {
  const cls = tone === "stop" ? "border-stop/30 bg-red-50" : tone === "go" ? "border-go/30 bg-green-50" : "border-wait/30 bg-amber-50";
  return <div role="status" className={`rounded border p-3 text-sm ${cls}`}>{children}</div>;
}

function QuestionCard({ q, checking, onAnswer }: { q: Question; checking: boolean; onAnswer: (value: string | null) => void }) {
  const [text, setText] = useState(q.answer?.startsWith("text:") ? q.answer.slice(5) : "");
  const initialMulti = q.answer != null ? (q.answer ? q.answer.split(",") : []) : q.options.filter((o) => o.recommended).map((o) => o.value);
  const [picked, setPicked] = useState<string[]>(initialMulti);
  const answered = q.answer != null;
  return (
    <div className={`card p-3 ${answered ? "" : "border-wait"}`}>
      <p className="text-sm font-medium">{q.prompt}</p>
      {q.error ? <p className={`mt-1 text-xs ${checking ? "text-muted" : "text-stop"}`}>{checking ? "Checking the machine records…" : q.error}</p> : null}
      {q.multi ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap gap-3">
            {q.options.map((o) => (
              <label key={o.value} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={picked.includes(o.value)} onChange={(e) => setPicked((x) => e.target.checked ? [...x, o.value] : x.filter((v) => v !== o.value))} />
                {o.label}
              </label>
            ))}
          </div>
          <div><button type="button" className={answered && q.answer === picked.join(",") ? "btn" : "btn btn-primary"} onClick={() => onAnswer(q.options.map((o) => o.value).filter((v) => picked.includes(v)).join(","))}>
            {answered && q.answer === q.options.map((o) => o.value).filter((v) => picked.includes(v)).join(",") ? "Confirmed" : "Confirm"}
          </button></div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {q.options.map((o) => {
            const on = q.answer === o.value;
            return (
              <button key={o.value} type="button" aria-pressed={on} onClick={() => onAnswer(on ? null : o.value)}
                className={`btn flex-col items-start text-left ${on ? "btn-primary" : ""}`}>
                <span>{o.label}{o.recommended && !on ? <span className="ml-1 text-xs text-muted">(suggested)</span> : null}</span>
                {o.detail ? <span className={`text-xs ${on ? "text-white/80" : "text-muted"}`}>{o.detail}</span> : null}
              </button>
            );
          })}
        </div>
      )}
      {q.allowText ? (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswer(`text:${text.trim()}`); }}>
          <label className="text-xs text-muted" htmlFor={`${q.id}-text`}>{q.allowText.label}</label>
          <input id={`${q.id}-text`} className="input w-44" value={text} placeholder={q.allowText.placeholder} onChange={(e) => setText(e.target.value)} />
          <button className={q.answer === `text:${text.trim()}` && text.trim() ? "btn btn-primary" : "btn"}>Use</button>
        </form>
      ) : null}
    </div>
  );
}

function appended(c: FieldChange): string | null {
  if (!c.from || !c.to || !c.to.startsWith(c.from)) return null;
  return c.to.slice(c.from.length).trim();
}

function EntryChanges({ e }: { e: PlannedEntry }) {
  return (
    <div className="card p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {e.machineNo
          ? <span className="mono font-semibold">#{e.machineNo}</span>
          : <span className="text-sm text-muted">{e.label}: {e.skipped ? "skipped" : "answer the machine question first"}</span>}
        {e.fact ? <span className="text-xs text-muted">{machineSummary(e.fact)}</span> : null}
      </div>
      {e.changes.length ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className="w-28">Field</th><th>Now</th><th>After</th></tr></thead>
            <tbody>
              {e.changes.map((c) => {
                const add = appended(c);
                return (
                  <tr key={c.field}>
                    <td className="text-xs text-muted">{FIELD_LABEL[c.field]}</td>
                    <td className="text-xs">{c.field === "notes" || c.field === "diagnosis" ? (c.from ? <span className="line-clamp-2 text-muted">{c.from}</span> : "—") : c.from || "—"}</td>
                    <td className="text-xs">{add != null ? <><span className="text-muted">adds </span><span className="font-medium">{add}</span></> : <span className="font-medium">{c.field === "stickerPrice" ? `$${c.to}` : c.to}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : e.machineNo && !e.parts.length && !e.history.length ? <p className="mt-1 text-xs text-muted">Nothing changes for this machine.</p> : null}
      {e.locationCheck ? (
        <p className="mt-2 text-xs"><span className="pill pill-stop">VERIFY LOCATION</span> on record: {e.locationCheck.from}; this note: {e.locationCheck.to}. Both stay in the history until someone checks.</p>
      ) : null}
      {e.parts.length ? (
        <ul className="mt-2 list-disc pl-5 text-xs">
          {e.parts.map((d, i) => (
            <li key={`${d.machineNo}-${d.mpn ?? d.name}-${i}`} className={d.applied ? "" : "text-muted"}>
              {d.name || "Part"}{d.mpnDisplay ? <span className="mono"> {d.mpnDisplay}</span> : null} on #{d.machineNo}: <span className="font-medium">{PART_KIND_LABEL[d.kind]}</span>
              {d.applied ? (d.kind === "failed" || d.kind === "missing" || d.kind === "removed") && d.mpn ? " · off pick lists" : d.testFirst ? ` · ${d.testFirst} parts marked test first` : "" : " · history only (older note)"}
            </li>
          ))}
        </ul>
      ) : null}
      {e.history.length ? (
        <div className="mt-2 text-xs text-muted">
          Kept as history only, because the record is newer or you chose to keep it: {e.history.map((c) => `${FIELD_WORD[c.field]} ${c.field === "stickerPrice" ? `$${c.to}` : `"${c.to}"`}`).join("; ")}
        </div>
      ) : null}
      {e.struck.length ? <p className="mt-2 text-xs text-muted">Crossed out on the note, not applied: <span className="line-through">{e.struck.join("; ")}</span></p> : null}
      {e.info.map((i) => <p key={i} className="mt-1 text-xs text-muted">{i}</p>)}
    </div>
  );
}

function ReadingEditor({ reading, onChange, locations }: { reading: NoteReading; onChange: (r: NoteReading) => void; locations: string[] }) {
  const setEntry = (key: string, patch: (e: ReadEntry) => ReadEntry) =>
    onChange({ ...reading, entries: reading.entries.map((e) => (e.key === key ? patch(e) : e)) });
  return (
    <div className="mt-3 flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap gap-3">
        <Field label="Date on the note">
          <input className="input w-32" value={reading.date.text} placeholder="M/D/YY" onChange={(e) => onChange({ ...reading, date: { text: e.target.value, confidence: "high" } })} />
        </Field>
        <Field label="Tech">
          <input className="input w-20" value={reading.tech} onChange={(e) => onChange({ ...reading, tech: e.target.value })} />
        </Field>
      </div>
      {reading.groups.map((g) => (
        <div key={g.key} className="rounded border border-line p-2 text-xs">
          Written once for several machines: <span className="font-medium">{g.text || [g.status.phrases.join(" "), g.location.name, g.location.text].filter(Boolean).join(" · ")}</span>
          <button type="button" className="btn ml-2 px-2 py-0.5 text-xs" onClick={() => onChange({ ...reading, groups: reading.groups.filter((x) => x.key !== g.key) })}>Remove this line</button>
        </div>
      ))}
      {reading.entries.map((e, i) => (
        <fieldset key={e.key} className="rounded border border-line p-3">
          <legend className="px-1 text-xs text-muted">Machine {i + 1}</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Machine #">
              <input className="input mono" inputMode="numeric" value={e.machine.text}
                onChange={(ev) => setEntry(e.key, (x) => ({ ...x, machine: { text: ev.target.value, confidence: "high", alternatives: [] } }))} />
            </Field>
            <Field label="Status written">
              <select className="input" value={e.status.checked}
                onChange={(ev) => setEntry(e.key, (x) => ({ ...x, status: { checked: ev.target.value, phrases: [], confidence: "high" } }))}>
                <option value="">None written</option>
                {NOTE_STATUSES.map((s) => <option key={s.status} value={s.status}>{s.status}</option>)}
              </select>
              {e.status.phrases.length ? <span className="text-xs text-muted">Words on the note: {e.status.phrases.join(", ")}</span> : null}
            </Field>
            <Field label="Location marked">
              <select className="input" value={locations.includes(e.location.name) ? e.location.name : ""}
                onChange={(ev) => setEntry(e.key, (x) => ({ ...x, location: { ...x.location, name: ev.target.value, confidence: "high" } }))}>
                <option value="">Not marked</option>
                {locations.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </Field>
            <Field label="Location words">
              <input className="input" value={e.location.text} placeholder="as written"
                onChange={(ev) => setEntry(e.key, (x) => ({ ...x, location: { ...x.location, text: ev.target.value, confidence: "high" } }))} />
            </Field>
            <Field label="Grade">
              <select className="input" value={e.grade} onChange={(ev) => setEntry(e.key, (x) => ({ ...x, grade: ev.target.value }))}>
                <option value="">Not marked</option>
                {SALE_GRADES.map((g) => <option key={g.grade} value={g.grade}>{g.condition}</option>)}
              </select>
            </Field>
            <Field label="Price">
              <input className="input w-28" value={e.price.text} placeholder="$" onChange={(ev) => setEntry(e.key, (x) => ({ ...x, price: { text: ev.target.value, confidence: "high" } }))} />
            </Field>
            <Field label="Model on the note (optional)">
              <input className="input mono" value={e.model} onChange={(ev) => setEntry(e.key, (x) => ({ ...x, model: ev.target.value }))} />
            </Field>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" checked={e.readyForClean} onChange={(ev) => setEntry(e.key, (x) => ({ ...x, readyForClean: ev.target.checked }))} />
              Ready for clean
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
            {CARD_SYMPTOMS.map((s) => (
              <label key={s.key} className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={e.symptoms.includes(s.key)}
                  onChange={(ev) => setEntry(e.key, (x) => ({ ...x, symptoms: ev.target.checked ? [...x.symptoms, s.key] : x.symptoms.filter((k) => k !== s.key) }))} />
                {s.label}
              </label>
            ))}
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <Field label="What is wrong">
              <textarea className="input min-h-16" value={e.problem} onChange={(ev) => setEntry(e.key, (x) => ({ ...x, problem: ev.target.value }))} />
            </Field>
            <Field label="Work done">
              <textarea className="input min-h-16" value={e.workDone} onChange={(ev) => setEntry(e.key, (x) => ({ ...x, workDone: ev.target.value }))} />
            </Field>
            <Field label="Other note">
              <textarea className="input min-h-16" value={e.note} onChange={(ev) => setEntry(e.key, (x) => ({ ...x, note: ev.target.value }))} />
            </Field>
          </div>
          <PartsEditor parts={e.parts} onChange={(parts) => setEntry(e.key, (x) => ({ ...x, parts }))} />
          {e.struck.length ? <p className="mt-2 text-xs text-muted">Crossed out: <span className="line-through">{e.struck.join("; ")}</span></p> : null}
          <button type="button" className="btn mt-3 text-xs" onClick={() => onChange({ ...reading, entries: reading.entries.filter((x) => x.key !== e.key), groups: reading.groups.map((g) => ({ ...g, appliesTo: g.appliesTo.filter((k) => k !== e.key) })) })}
            disabled={reading.entries.length === 1}>Remove machine {i + 1}</button>
        </fieldset>
      ))}
      <div><button type="button" className="btn" onClick={() => onChange({ ...reading, entries: [...reading.entries, emptyEntry()] })}>Add a machine</button></div>
    </div>
  );
}

function PartsEditor({ parts, onChange }: { parts: ReadPart[]; onChange: (parts: ReadPart[]) => void }) {
  const set = (key: string, patch: Partial<ReadPart>) => onChange(parts.map((p) => (p.key === key ? { ...p, ...patch, confidence: "high" } : p)));
  return (
    <div className="mt-3">
      <div className="text-xs text-muted">Parts</div>
      {parts.map((p) => (
        <div key={p.key} className="mt-1 flex flex-wrap items-end gap-2">
          <select className="input" value={p.action} aria-label="What happened to the part" onChange={(e) => set(p.key, { action: e.target.value as ReadPart["action"] })}>
            {PART_ACTIONS.map((a) => <option key={a} value={a}>{{ replaced: "Replaced", needed: "Needed", taken: "Taken out", suspected: "Suspected (check)", mentioned: "Mentioned" }[a]}</option>)}
          </select>
          <input className="input mono w-36" placeholder="Part #" aria-label="Part number" value={p.mpn} onChange={(e) => set(p.key, { mpn: e.target.value })} />
          <input className="input w-36" placeholder="Part name" aria-label="Part name" value={p.name} onChange={(e) => set(p.key, { name: e.target.value })} />
          {p.action === "replaced" || p.action === "taken" ? (
            <input className="input mono w-28" inputMode="numeric" aria-label={p.action === "replaced" ? "From machine #" : "For machine #"}
              placeholder={p.action === "replaced" ? "from #" : "for #"} value={p.otherMachine} onChange={(e) => set(p.key, { otherMachine: e.target.value.replace(/\D/g, "") })} />
          ) : null}
          {p.action !== "replaced" && p.action !== "taken" ? (
            <select className="input" value={p.condition} aria-label="Written as bad or missing" onChange={(e) => set(p.key, { condition: e.target.value as ReadPart["condition"] })}>
              <option value="">Not written bad or missing</option><option value="bad">Written: bad</option><option value="missing">Written: missing</option>
            </select>
          ) : null}
          <button type="button" className="btn px-2 text-xs" onClick={() => onChange(parts.filter((x) => x.key !== p.key))}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn mt-2 text-xs" onClick={() => onChange([...parts, emptyPart()])}>Add a part line</button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1"><span className="text-xs text-muted">{label}</span>{children}</label>;
}

function Submit({ label, pendingLabel, disabled }: { label: string; pendingLabel: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return <button className="btn btn-primary" disabled={disabled || pending}>{pending ? pendingLabel : label}</button>;
}

function ApplyBar({ noteId, plan, reading, answers, facts, applyAction, saveDraftAction }: {
  noteId: string; plan: Plan; reading: NoteReading; answers: Answers; facts: PlanFacts;
  applyAction: Action; saveDraftAction: NoteReviewProps["saveDraftAction"];
}) {
  const [result, formAction] = useActionState(applyAction, null);
  const [draft, setDraft] = useState<ActionResult | null>(null);
  const versions = Object.fromEntries(plan.entries.filter((e) => e.fact).map((e) => [e.fact!.machineNo, facts.machines[e.fact!.machineNo]?.version ?? e.fact!.version]));
  const machines = plan.entries.filter((e) => e.changes.length || e.parts.length || e.history.length).length;
  const blocker = plan.unanswered ? `Answer ${plan.unanswered === 1 ? "the last question" : `${plan.unanswered} questions`} to apply.` : !plan.hasChanges ? "Nothing to apply yet." : !plan.date ? "Settle the note's date to apply." : null;
  return (
    <div className="sticky bottom-0 -mx-1 border-t border-line bg-paper/95 px-1 py-3 backdrop-blur">
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={noteId} />
        <input type="hidden" name="reading" value={JSON.stringify(reading)} />
        <input type="hidden" name="answers" value={JSON.stringify(answers)} />
        <input type="hidden" name="versions" value={JSON.stringify(versions)} />
        <Submit label={machines ? `Apply to ${machines} machine${machines === 1 ? "" : "s"}` : "Apply"} pendingLabel="Applying…" disabled={!plan.ready} />
        <button type="button" className="btn" onClick={() => startTransition(async () => setDraft(await saveDraftAction(noteId, reading, answers)))}>Save for later</button>
        <span className="text-xs text-muted">{blocker}</span>
      </form>
      {result && !result.ok ? <p role="alert" className="mt-2 text-sm text-stop">{result.message}</p> : null}
      {draft ? <p role="status" className={`mt-2 text-sm ${draft.ok ? "text-go" : "text-stop"}`}>{draft.message}</p> : null}
    </div>
  );
}

function ActionButton({ action, noteId, label, pendingLabel }: { action: Action; noteId: string; label: string; pendingLabel: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={noteId} />
      <SubmitPlain label={label} pendingLabel={pendingLabel} />
      {state ? <span role="status" className={`text-xs ${state.ok ? "text-go" : "text-stop"}`}>{state.message}</span> : null}
    </form>
  );
}

function SubmitPlain({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return <button className="btn" disabled={pending}>{pending ? pendingLabel : label}</button>;
}

function DiscardButton({ action, noteId }: { action: Action; noteId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useActionState(action, null);
  if (!confirming) return <button type="button" className="btn" onClick={() => setConfirming(true)}>Discard note</button>;
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={noteId} />
      <span className="text-xs">Discard? Nothing on it is applied.</span>
      <SubmitPlain label="Yes, discard" pendingLabel="Discarding…" />
      <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
      {state && !state.ok ? <span className="text-xs text-stop">{state.message}</span> : null}
    </form>
  );
}
