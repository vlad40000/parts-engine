import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, hasDatabase } from "@/src/db";
import { getTechNote, loadPlanFacts } from "@/src/db/tech-notes";
import { readerConfig } from "@/src/lib/tech-notes/reader";
import { emptyReading } from "@/src/lib/tech-notes/reading";
import type { Plan } from "@/src/lib/tech-notes/plan";
import { NoDatabase, PageTitle } from "@/src/components/ui";
import { NoteReview } from "@/src/components/note-review";
import { applyNoteAction, discardNoteAction, loadFactsAction, rereadNoteAction, saveDraftAction } from "../actions";

export const dynamic = "force-dynamic";
// Re-reading a card waits on the card reader.
export const maxDuration = 120;

const FIELD: Record<string, string> = { availability: "Status", condition: "Condition", location: "Location", diagnosis: "Diagnosis", notes: "Repair notes", stickerPrice: "Sticker price" };

export default async function NotePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (!hasDatabase()) return <NoDatabase />;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const db = await getDb();
  const note = await getTechNote(db, id);
  if (!note) notFound();

  if (note.status === "open") {
    const reading = note.reading ?? emptyReading();
    const facts = await loadPlanFacts(db, reading, note.answers);
    return (
      <>
        <PageTitle title="Review tech note" sub={<><Link className="text-accent underline" href="/notes">Tech notes</Link> · Answer the questions, check what will change, then apply.</>} />
        <NoteReview
          key={note.updatedAt}
          noteId={note.id} origin={note.origin} hasPhoto={note.hasPhoto} readerModel={note.readerModel} readerError={note.readerError}
          createdAt={note.createdAt} duplicate={sp.dup === "1"} canReread={note.hasPhoto && Boolean(readerConfig())}
          initialReading={reading} initialAnswers={note.answers} initialFacts={facts}
          applyAction={applyNoteAction} rereadAction={rereadNoteAction} discardAction={discardNoteAction}
          saveDraftAction={saveDraftAction} loadFactsAction={loadFactsAction}
        />
      </>
    );
  }

  const plan = note.appliedPlan as Plan | null;
  return (
    <>
      <PageTitle title={note.status === "applied" ? "Applied tech note" : "Discarded tech note"} sub={<Link className="text-accent underline" href="/notes">Tech notes</Link>} />
      {sp.dup === "1" ? <div role="status" className="mb-4 rounded border border-wait/30 bg-amber-50 p-3 text-sm">This photo was uploaded before. It is already {note.status}, so nothing was applied twice.</div> : null}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <aside>
          {note.hasPhoto ? (
            <a href={`/notes/${note.id}/photo`} target="_blank" rel="noreferrer" className="card block overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/notes/${note.id}/photo`} alt="Photo of the tech note" className="max-h-[70vh] w-full object-contain" />
            </a>
          ) : <div className="card p-4 text-sm text-muted">Typed note: no photo.</div>}
          <p className="mt-2 text-xs text-muted">{note.status === "applied" ? `Applied ${note.appliedAt}` : "Discarded: nothing was applied."}</p>
        </aside>
        <div className="flex min-w-0 flex-col gap-3">
          {plan?.entries.filter((e) => e.machineNo && (e.changes.length || e.partStates.length)).map((e) => (
            <div key={e.key} className="card p-3">
              <Link className="mono font-semibold text-accent hover:underline" href={`/machines/${encodeURIComponent(e.machineNo!)}`}>#{e.machineNo}</Link>
              <table className="mt-2 w-full text-sm">
                <tbody>
                  {e.changes.map((c) => (
                    <tr key={c.field}><td className="w-28 text-xs text-muted">{FIELD[c.field]}</td><td className="text-xs text-muted">{c.from || "—"}</td><td className="text-xs font-medium">{c.to}</td></tr>
                  ))}
                </tbody>
              </table>
              {e.partStates.length ? <ul className="mt-2 list-disc pl-5 text-xs">{e.partStates.map((s) => <li key={`${s.machineNo}-${s.mpn}`}>{s.mpnDisplay} marked {s.state} on #{s.machineNo}</li>)}</ul> : null}
            </div>
          ))}
          {plan?.locationsToAdd.length ? <p className="text-sm">Added location{plan.locationsToAdd.length > 1 ? "s" : ""}: {plan.locationsToAdd.map((l) => l.name).join(", ")}.</p> : null}
          {note.status === "discarded" ? <p className="text-sm text-muted">This note was discarded.</p> : null}
        </div>
      </div>
    </>
  );
}
