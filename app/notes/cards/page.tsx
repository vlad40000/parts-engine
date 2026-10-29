import Link from "next/link";
import { getDb, hasDatabase } from "@/src/db";
import { locationList } from "@/src/db/tech-notes";
import { NoDatabase, PageTitle } from "@/src/components/ui";
import { PrintButton } from "@/src/components/print-button";
import { CARD_CODES, CARD_STATUSES, CARD_SYMPTOMS, MOVE_CARD_MACHINES, REPAIR_CARD_PART_LINES, SALE_GRADES } from "@/src/lib/tech-notes/vocabulary";

export const dynamic = "force-dynamic";

function Boxes({ n, size = "md", label }: { n: number; size?: "sm" | "md"; label?: string }) {
  return (
    <span className={`rr-comb rr-comb-${size}`} aria-label={label}>
      {Array.from({ length: n }, (_, i) => <span key={i} className="rr-box" />)}
    </span>
  );
}
const Check = ({ children }: { children: React.ReactNode }) => <span className="rr-check"><span className="rr-tick" />{children}</span>;
function DateBoxes() {
  return <span className="rr-date"><Boxes n={2} size="sm" /><b>/</b><Boxes n={2} size="sm" /><b>/</b><Boxes n={2} size="sm" /></span>;
}

function Header({ title, code }: { title: string; code: string }) {
  return (
    <div className="rr-head">
      <span><b>ROAD RUNNER</b> · {title}</span>
      <span className="rr-code">{code}</span>
    </div>
  );
}

function MoveCard({ locations }: { locations: string[] }) {
  return (
    <div className="rr-card rr-quarter">
      <Header title="STATUS / MOVE" code={CARD_CODES.move} />
      <p className="rr-hint">One digit per box. Mark ONE status and ONE location for every machine on this card. Cross out mistakes with one line.</p>
      <div className="rr-label">Machine # (same status and location)</div>
      <div className="rr-ids">
        {Array.from({ length: MOVE_CARD_MACHINES }, (_, i) => <Boxes key={i} n={5} label={`Machine number ${i + 1}`} />)}
      </div>
      <div className="rr-row"><span className="rr-label">Date</span><DateBoxes /><span className="rr-label">Tech</span><Boxes n={3} size="sm" /></div>
      <div className="rr-label">Status (one)</div>
      <div className="rr-grid2">{CARD_STATUSES.map((s) => <Check key={s.status}>{s.label}</Check>)}<Check>Ready for clean</Check></div>
      <div className="rr-label">Location (one)</div>
      <div className="rr-grid2">{locations.slice(0, 10).map((l) => <Check key={l}>{l}</Check>)}</div>
      <div className="rr-row"><Check>Other:</Check><span className="rr-line rr-grow" /></div>
      <div className="rr-row"><span className="rr-label">Grade</span>{SALE_GRADES.map((g) => <Check key={g.grade}>{g.grade}</Check>)}<span className="rr-label">Price $</span><Boxes n={4} size="sm" /></div>
      <div className="rr-label">Note</div>
      <div className="rr-line" /><div className="rr-line" />
      <p className="rr-foot">No customer names or phone numbers on this card.</p>
    </div>
  );
}

function RepairCard({ locations }: { locations: string[] }) {
  return (
    <div className="rr-card rr-half">
      <Header title="REPAIR CARD" code={CARD_CODES.repair} />
      <div className="rr-row">
        <span className="rr-label">Machine #</span><Boxes n={5} label="Machine number" />
        <span className="rr-label">Date</span><DateBoxes />
        <span className="rr-label">Tech</span><Boxes n={3} size="sm" />
        <span className="rr-label">Grade</span>{SALE_GRADES.map((g) => <Check key={g.grade}>{g.grade}</Check>)}
        <span className="rr-label">Price $</span><Boxes n={4} size="sm" />
      </div>
      <div className="rr-row"><span className="rr-label">Model # (optional)</span><Boxes n={16} size="sm" label="Model number" /></div>
      <div className="rr-cols">
        <div>
          <div className="rr-label">Status (one)</div>
          <div className="rr-grid2">{CARD_STATUSES.map((s) => <Check key={s.status}>{s.label}</Check>)}<Check>Ready for clean</Check></div>
          <div className="rr-label">Location (one)</div>
          <div className="rr-grid2">{locations.slice(0, 12).map((l) => <Check key={l}>{l}</Check>)}</div>
          <div className="rr-row"><Check>Other:</Check><span className="rr-line rr-grow" /></div>
        </div>
        <div>
          <div className="rr-label">What is wrong (all that apply)</div>
          <div className="rr-grid3">{CARD_SYMPTOMS.map((s) => <Check key={s.key}>{s.label}</Check>)}</div>
          <div className="rr-label">Details</div>
          <div className="rr-line" /><div className="rr-line" />
          <div className="rr-label">Work done</div>
          <div className="rr-line" />
        </div>
      </div>
      <table className="rr-parts">
        <thead>
          <tr><th>Replaced</th><th>Needed</th><th>Taken out</th><th>Part # (one character per box)</th><th>Part name</th><th>Machine #</th><th>Bad</th><th>Missing</th></tr>
        </thead>
        <tbody>
          {Array.from({ length: REPAIR_CARD_PART_LINES }, (_, i) => (
            <tr key={i}>
              <td><span className="rr-tick" /></td><td><span className="rr-tick" /></td><td><span className="rr-tick" /></td>
              <td><Boxes n={12} size="sm" /></td><td className="rr-name"><span className="rr-line" /></td><td><Boxes n={5} size="sm" /></td>
              <td><span className="rr-tick" /></td><td><span className="rr-tick" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="rr-foot">Replaced = put into this machine (Machine # = where it came from). Taken out = removed from this machine for Machine #. Needed: mark Bad or Missing. No customer names or phone numbers on this card.</p>
    </div>
  );
}

export default async function CardsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!hasDatabase()) return <NoDatabase />;
  const sp = await searchParams;
  const card = sp.card === "repair" ? "repair" : "move";
  const locations = (await locationList(await getDb(), true)).map((l) => l.name);
  return (
    <>
      <div className="no-print">
        <PageTitle
          title={card === "move" ? "Status / Move cards" : "Repair cards"}
          sub={<>
            <Link className="text-accent underline" href="/notes">Tech notes</Link> · Print on letter paper at 100% (Actual size), then cut on the dashed lines.
            {card === "move" ? " Four quarter-sheet cards per page." : " Two half-sheet cards per page."} The location boxes come from the location list,
            so reprint after a new location is added.
          </>}
        />
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <PrintButton />
          <Link className="btn" href={`/notes/cards?card=${card === "move" ? "repair" : "move"}`}>{card === "move" ? "Repair cards" : "Status / Move cards"}</Link>
        </div>
      </div>
      <div className="rr-sheet-wrap">
        <div className={`rr-sheet ${card === "move" ? "rr-sheet-quarters" : "rr-sheet-halves"}`}>
          {card === "move"
            ? Array.from({ length: 4 }, (_, i) => <MoveCard key={i} locations={locations} />)
            : Array.from({ length: 2 }, (_, i) => <RepairCard key={i} locations={locations} />)}
        </div>
      </div>
    </>
  );
}
