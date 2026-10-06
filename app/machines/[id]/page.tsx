import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, hasDatabase } from "@/src/db";
import { machineDetail } from "@/src/db/queries";
import { NoDatabase, PageTitle, QualificationPill, RoadrunnerHistory, usd, Years } from "@/src/components/ui";
import { setPartStateAction } from "../../actions";

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
  const d = await machineDetail(await getDb(), decodeURIComponent(id));
  if (!d) notFound();
  const { machine: m, bom, parts } = d;
  const qualified = parts.filter((p) => p.qualification?.result === "QUALIFIED" && !p.state);
  const setRule = parts.some((p) => p.qualification?.result === "SET_RULE");

  return (
    <>
      <PageTitle title={`Machine ${m.machineNo}`} sub={`${m.brand} ${m.modelRaw} · ${m.applianceType} · ${m.availability}`} />
      <div className="mb-5 grid gap-3 text-sm md:grid-cols-3">
        <div className="card p-3"><div className="text-xs text-muted">Serial</div><div className="mono">{m.serial || "—"}</div>
          <div className="mt-2 text-xs text-muted">Possible build years</div><Years years={m.ageCandidateYears} /><div className="text-xs text-muted">{m.ageNote}</div></div>
        <div className="card p-3"><div className="text-xs text-muted">Failure symptom</div><div>{m.diagnosis || "—"}</div>
          <div className="mt-2 text-xs text-muted">Parts in these families are marked test first</div><div>{m.suspectFamilies.join(", ") || "none"}</div></div>
        <div className="card p-3"><div className="text-xs text-muted">Parts list</div>
          <BomStatus bom={bom} identityOk={m.identityStatus === "ok"} />
          <div className="mt-2 text-xs text-muted">Qualified parts still inside</div>
          <div className="text-lg font-semibold">{setRule ? <Link className="text-sm text-accent underline" href="/settings">Set qualification rules</Link> : qualified.length}</div></div>
      </div>
      {m.identityStatus !== "ok" ? <div className="card mb-5 p-3 text-sm text-wait">Model is unreadable. Read the nameplate and update this machine on Intake before it can be matched.</div> : null}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th>Diagram</th><th>MPN</th><th>Description</th><th>Family</th><th className="num">Min</th><th className="num">New $</th><th className="num">Break-even</th><th>Qualification</th><th>Roadrunner history</th><th>State</th></tr></thead>
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
                <td><StateButtons machineNo={m.machineNo} mpn={p.mpn_canonical} state={p.state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
