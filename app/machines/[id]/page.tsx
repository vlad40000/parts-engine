import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, hasDatabase } from "@/src/db";
import { machineDetail } from "@/src/db/queries";
import { machineHistory, openLocationChecks, pendingMachineNotes } from "@/src/db/tech-notes";
import { VerifyLocation } from "@/src/components/verify-location";
import { NoDatabase, PageTitle, QualificationPill, RoadrunnerHistory, usd, Years } from "@/src/components/ui";
import { setPartDispositionAction, setPartStateAction, updateMachineLocationAction, verifyLocationAction } from "../../actions";
import { PartDispositionControl } from "@/src/components/part-disposition-control";
import { LocationEditCell } from "@/src/components/location-edit-cell";
import { StatusEditCell } from "@/src/components/status-edit-cell";
import { VerifyReturn } from "@/src/components/verify-return";
import { ButtonForm } from "@/src/components/forms";
import { CONDITION_FOR_STATUS } from "@/src/lib/tech-notes/vocabulary";
import { updateMachineStatusAction, verifyMachineReturnAction } from "../../actions";

export const dynamic = "force-dynamic";

function StateButtons({ machineNo, mpn, state }: { machineNo: string; mpn: string; state: string | null }) {
  const opts = state ? ["clear"] : ["pulled", "failed", "missing"];
  return (
    <form action={setPartStateAction} className="flex gap-1">
      <input type="hidden" name="machineNo" value={machineNo} />
      <input type="hidden" name="mpn" value={mpn} />
      {state ? <span className="pill pill-mute mr-1">{state}</span> : null}
      {opts.map((o) => <button key={o} name="state" value={o} className="btn px-2 py-0.5 text-xs">{o === "clear" ? "undo" : o}</button>)}
    </form>
  );
}

type Bom = NonNullable<Awaited<ReturnType<typeof machineDetail>>>["bom"];

function BomStatus({ bom, identityOk }: { bom: Bom; identityOk: boolean }) {
  const queue = <Link className="text-accent underline" href="/bom">Parts lists</Link>;
  if (!identityOk) return <div className="text-wait">Not looked up: model unreadable.</div>;
  if (!bom) return <div>Not read yet. {queue}</div>;
  if (bom.status === "found") return <div>{bom.rowCount} parts from {bom.source ?? "—"} ({bom.status})</div>;
  if (bom.status === "not_found") return <div className="text-wait">Unavailable: no supplier has a parts list for this model (not_found). No parts evaluated.</div>;
  return <div className="text-stop">Unavailable: supplier lookup failed (error). No parts evaluated; queued for retry in {queue}.</div>;
}

export default async function MachinePage({ params }: { params: Promise<{ id: string }> }) {
  if (!hasDatabase()) return <NoDatabase />;
  const { id } = await params;
  const db = await getDb();
  const machineNo = decodeURIComponent(id);
  const [d, history, checks, pendingNotes] = await Promise.all([machineDetail(db, machineNo), machineHistory(db, machineNo), openLocationChecks(db, machineNo), pendingMachineNotes(db, machineNo)]);
  if (!d) notFound();
  const { machine: m, bom, parts } = d;
  const qualified = parts.filter((p) => p.qualification?.result === "QUALIFIED" && !p.state);
  const setRule = parts.some((p) => p.qualification?.result === "SET_RULE");
  const expectedCondition = CONDITION_FOR_STATUS[m.availability];
  const staleStandardCondition = Boolean(expectedCondition && m.condition && m.condition !== expectedCondition
    && Object.values(CONDITION_FOR_STATUS).includes(m.condition));

  return (
    <>
      <PageTitle title={`Machine ${m.machineNo}`} sub={`${m.brand} ${m.modelRaw} · ${m.applianceType} · ${m.availability}`} />
      {pendingNotes.some((n) => n.verifyReturn) ? (
        <VerifyReturn machineNo={m.machineNo} status={m.availability} location={m.location}
          action={verifyMachineReturnAction} />
      ) : null}
      {pendingNotes.length ? (
        <section role="alert" className="card mb-4 border border-wait/40 bg-amber-50 p-3 text-sm">
          <div className="font-semibold">TECH NOTE REVIEW — {pendingNotes.length} pending service observation{pendingNotes.length === 1 ? "" : "s"}</div>
          <p className="mt-1 text-xs">These notes have been saved, but have not been applied. The latest dated location/status must be reconciled before changing the fleet record.</p>
          <ul className="mt-2 list-disc pl-5 text-xs">
            {pendingNotes.map((n) => (
              <li key={n.id}>
                <Link className="text-accent underline" href={`/notes/${n.id}`}>Review note{n.written ? ` (${n.written})` : " (undated)"}</Link>
                {n.verifyReturn ? " · VERIFY RETURN (SOLD but photographed on lot)" : ""}
                {n.location && n.location.toLowerCase() !== (m.location ?? "").toLowerCase() ? ` · LOCATION CONFLICT: ${n.location} vs ${m.location ?? "unknown"}` : ""}
                {n.status && n.status.toUpperCase() !== m.availability.toUpperCase() ? ` · STATUS CONFLICT: ${n.status} vs ${m.availability}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {checks.length ? <VerifyLocation machineNo={m.machineNo} current={m.location} checks={checks} action={verifyLocationAction} /> : null}
      <div className="mb-5 grid gap-3 text-sm md:grid-cols-3">
        <div className="card p-3">
          <div className="text-xs text-muted">Status</div>
          <StatusEditCell machineNo={m.machineNo} status={m.availability} action={updateMachineStatusAction} />
          <div className="mt-2 text-xs text-muted">Physical location</div>
          <LocationEditCell machineNo={m.machineNo} location={m.location} action={updateMachineLocationAction} />
          <div className="mt-2 text-xs text-muted">Condition</div>
          <div>{m.condition || "—"}{m.stickerPrice ? ` · sticker ${Number(m.stickerPrice).toFixed(0)}` : ""}</div>
          {staleStandardCondition ? (
            <div role="alert" className="mt-2 border-l-2 border-wait pl-2 text-xs">
              Condition is a legacy status code that does not match the current status. Expected: {expectedCondition}.
              <div className="mt-2">
                <ButtonForm action={updateMachineStatusAction} label="Align standard condition">
                  <input type="hidden" name="machineNo" value={m.machineNo} />
                  <input type="hidden" name="expectedStatus" value={m.availability} />
                  <input type="hidden" name="status" value={m.availability} />
                </ButtonForm>
              </div>
            </div>
          ) : null}
          {m.localFields.length ? <div className="mt-1 text-xs text-muted">Set from tech notes, kept on re-import: {m.localFields.join(", ").replace("sticker_price", "sticker price")}</div> : null}
          <div className="mt-2 text-xs text-muted">Serial</div><div className="mono">{m.serial || "—"}</div>
          <div className="mt-2 text-xs text-muted">Possible build years</div><Years years={m.ageCandidateYears} /><div className="text-xs text-muted">{m.ageNote}</div></div>
        <div className="card p-3"><div className="text-xs text-muted">Failure symptom</div><div>{m.diagnosis || "—"}</div>
          <div className="mt-2 text-xs text-muted">Parts in these families are marked test first</div><div>{m.suspectFamilies.join(", ") || "none"}</div></div>
        <div className="card p-3"><div className="text-xs text-muted">Parts list</div>
          <BomStatus bom={bom} identityOk={m.identityStatus === "ok"} />
          {bom?.status === "found" && parts.length > 0 ? (
            <>
              <a className="btn mt-2 inline-block text-xs" href={`/api/export/machine-parts/${encodeURIComponent(m.machineNo)}`}>
                Download all {parts.length} parts (CSV)
              </a>
              <p className="mt-1 text-xs text-muted">Includes unresearched, skipped, unqualified and previously removed parts. Model fitment is not confirmed physical stock.</p>
            </>
          ) : null}
          <div className="mt-2 text-xs text-muted">Qualified parts still inside</div>
          <div className="text-lg font-semibold">{setRule ? <Link className="text-sm text-accent underline" href="/settings">Set qualification rules</Link> : qualified.length}</div></div>
      </div>
      {history.length ? (
        <details className="card mb-5 p-3 text-sm">
          <summary className="cursor-pointer font-semibold">History ({history.length})</summary>
          <table className="mt-2 w-full text-xs">
            <thead><tr><th>Recorded</th><th>Observed</th><th>Field</th><th>Before</th><th>After</th><th>From</th></tr></thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i} className={h.applied ? "" : "text-muted"}>
                  <td className="whitespace-nowrap">{h.changed_at}</td>
                  <td className="whitespace-nowrap">{h.observed ?? ""}</td>
                  <td>{h.field.replace("_", " ")}{h.applied ? "" : " (history only: older than the record)"}</td>
                  <td className="text-muted">{h.previous_value ?? "—"}</td>
                  <td>{h.next_value ?? "—"}</td>
                  <td>{h.tech_note_id ? <Link className="text-accent underline" href={`/notes/${h.tech_note_id}`}>tech note</Link> : h.source === "fleet_ui" ? "Fleet edit" : h.source === "verified" ? "location check" : h.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      {m.identityStatus !== "ok" ? <div className="card mb-5 p-3 text-sm text-wait">Model is unreadable. Read the nameplate and update this machine on Intake before it can be matched.</div> : null}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th>Diagram</th><th>MPN</th><th>Description</th><th>Family</th><th className="num">Min</th><th className="num">New $</th><th className="num">Break-even</th><th>Qualification</th><th title="Sales events imported via the Roadrunner CSV on MPNs; not live eBay listing or sale status.">Roadrunner history</th><th>State</th></tr></thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.mpn_canonical} className={p.state ? "opacity-50" : ""}>
                <td className="text-xs">{p.diagram_id}</td>
                <td><Link className="mono text-accent hover:underline" href={`/mpns/${encodeURIComponent(p.mpn_canonical)}`}>{p.mpn_display}</Link></td>
                <td>{p.description}</td>
                <td className="text-xs text-muted">{p.part_family}{p.suspect ? <span className="pill pill-wait ml-1">test first</span> : null}</td>
                <td className="num">{p.removal.minutes ?? ""}</td>
                <td className="num">{p.new_price_min ? Number(p.new_price_min).toFixed(2) : ""}</td>
                <td className="num">{p.qualification?.economics ? usd(p.qualification.economics.breakEven) : ""}</td>
                <td>{p.prefilter && p.market === "missing" ? <span className="pill pill-mute" title={p.prefilter}>skipped</span> : <QualificationPill v={p.qualification} market={p.market} />}</td>
                <td><RoadrunnerHistory p={p.roadrunner} /></td>
                <td>{p.state === "pulled"
                  ? <PartDispositionControl machineNo={m.machineNo} mpn={p.mpn_canonical} disposition={p.disposition} soldPrice={p.soldPrice} repairMachineNo={p.repairMachineNo} token={p.partToken} action={setPartDispositionAction} />
                  : <StateButtons machineNo={m.machineNo} mpn={p.mpn_canonical} state={p.state} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
