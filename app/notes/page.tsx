import Link from "next/link";
import { getDb, hasDatabase } from "@/src/db";
import { listTechNotes } from "@/src/db/tech-notes";
import { readerConfig } from "@/src/lib/tech-notes/reader";
import { CARD_NAMES, isCardCode, parseCardDate, shortDate } from "@/src/lib/tech-notes/vocabulary";
import { NoDatabase, PageTitle } from "@/src/components/ui";
import { NoteUpload } from "@/src/components/note-upload";
import { readCardAction, startTypedNoteAction } from "./actions";

export const dynamic = "force-dynamic";
// Reading a card waits on the card reader.
export const maxDuration = 120;

/** The date written on the note: as applied (YYYY-MM-DD) or as read ("5/12/26"). */
const written = (w: string | null) => {
  if (!w) return "—";
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(w) ? w : parseCardDate(w);
  return iso ? shortDate(iso) : w;
};
const STATUS_PILL: Record<string, string> = { open: "pill pill-wait", applied: "pill pill-go", discarded: "pill pill-mute" };
const STATUS_TEXT: Record<string, string> = { open: "needs review", applied: "applied", discarded: "discarded" };

export default async function NotesPage() {
  if (!hasDatabase()) return <NoDatabase />;
  const notes = await listTechNotes(await getDb(), 40);
  return (
    <>
      <PageTitle
        title="Tech notes"
        sub="Photograph a field intake form or any tech note. The app reads it, asks about anything that is unclear or does not match the machine's record, and updates the machines once every question is answered. An older note never overrides a newer record."
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Read a form or note</h2>
          <NoteUpload action={readCardAction} readerReady={Boolean(readerConfig())} />
          <form action={startTypedNoteAction} className="mt-4 border-t border-line pt-3">
            <button className="btn">Type a note instead</button>
          </form>
        </section>
        <aside className="card p-4 text-sm">
          <h2 className="mb-2 font-semibold">Printable form</h2>
          <p className="mb-3 text-xs text-muted">Roadrunner Machine Service Update: Machine #, Date, Location, Current status and Notes.</p>
          <Link className="text-accent underline" href="/notes/cards" prefetch={false}>Standard form PDF</Link> <span className="text-xs text-muted">half sheet, 2 per page</span>
          <p className="mt-3 text-xs text-muted">Handwritten tech notes and the old cards are also accepted. The standard form is optional.</p>
        </aside>
      </div>

      <section className="card mt-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th>Written</th><th>Uploaded</th><th>Note</th><th>Machines</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {notes.map((n) => (
              <tr key={n.id}>
                <td className="whitespace-nowrap text-xs">{written(n.written)}</td>
                <td className="whitespace-nowrap text-xs text-muted">{n.created_at}</td>
                <td className="text-xs">{n.origin === "manual" ? "Typed" : n.card && isCardCode(n.card) ? CARD_NAMES[n.card] : "Photo"}{n.reader_error && n.status === "open" ? <span className="ml-1 text-stop">· not read</span> : null}</td>
                <td className="mono text-xs">{n.machines.map((m) => `#${m}`).join(" ") || "—"}</td>
                <td><span className={STATUS_PILL[n.status]}>{STATUS_TEXT[n.status]}</span></td>
                <td><Link className="text-accent hover:underline" href={`/notes/${n.id}`}>{n.status === "open" ? "Review" : "View"}</Link></td>
              </tr>
            ))}
            {!notes.length ? <tr><td colSpan={6} className="text-sm text-muted">No notes yet.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
