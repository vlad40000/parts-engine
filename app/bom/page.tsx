import Link from "next/link";
import { hasDatabase, getDb } from "@/src/db";
import { BOM_QUEUE_PAGE_SIZE, bomQueue, fleetFacets, getSettings } from "@/src/db/queries";
import { DEFAULT_AGE_BANDS } from "@/src/lib/serial-decoder";
import { BatchRunner } from "@/src/components/batch-runner";
import { NoDatabase, PageTitle, Pager, qs } from "@/src/components/ui";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | undefined>>;

export default async function BomPage({ searchParams }: { searchParams: SP }) {
  if (!hasDatabase()) return <NoDatabase />;
  const sp = await searchParams;
  const db = await getDb();
  const settings = await getSettings(db);
  const filter = { band: sp.band, type: sp.type, brand: sp.brand };
  const offset = Number(sp.offset ?? 0) || 0;
  const [queue, facets] = await Promise.all([
    bomQueue(db, filter, settings.donorAvailabilities, BOM_QUEUE_PAGE_SIZE, offset),
    fleetFacets(db)
  ]);
  const { totalModels, totalMachines } = queue;

  return (
    <>
      <PageTitle
        title="Parts lists"
        sub="Pick an age band to research first, then run models in batches. A band only sets the order — every machine that shares a part is still matched later, whatever its age."
      />
      <form className="mb-4 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Age band (any possible year)</span>
          <select name="band" defaultValue={sp.band ?? ""} className="input">
            <option value="">All</option>
            {DEFAULT_AGE_BANDS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
            <option value="unknown">Unknown age</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Type</span>
          <select name="type" defaultValue={sp.type ?? ""} className="input">
            <option value="">All</option>
            {facets.types.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Brand</span>
          <select name="brand" defaultValue={sp.brand ?? ""} className="input">
            <option value="">All</option>
            {facets.brands.map((b) => <option key={b}>{b}</option>)}
          </select>
        </label>
        <button className="btn">Filter</button>
      </form>
      <section className="card mb-4 p-4 text-sm">
        <p className="text-base">
          <b className="tabular-nums">{totalModels.toLocaleString()}</b> Brand + Model {totalModels === 1 ? "group needs" : "groups need"} a parts list
          {" · "}
          <b className="tabular-nums">{totalMachines.toLocaleString()}</b> donor {totalMachines === 1 ? "machine" : "machines"} in {totalModels === 1 ? "that group" : "those groups"}
        </p>
        <p className="mt-1 max-w-4xl text-xs text-muted">
          This is the grouped parts-list (BOM) queue, not the full <Link className="underline" href="/">Fleet</Link>: one row per Brand + Model,
          since one parts list covers every machine of that model. It counts only machines with a readable model whose status is a
          donor status in <Link className="underline" href="/settings">Settings</Link> ({settings.donorAvailabilities.join(", ") || "none set"})
          {filter.band || filter.type || filter.brand ? " and that match the filters above" : ""}. A model leaves the queue once its parts
          list is found or not found; failed lookups stay for retry.
        </p>
        {totalModels > BOM_QUEUE_PAGE_SIZE ? (
          <Pager total={totalModels} limit={BOM_QUEUE_PAGE_SIZE} offset={queue.offset} href={(o) => qs(filter, { offset: o })} />
        ) : totalModels ? (
          <p className="mt-3 text-muted">All {totalModels.toLocaleString()} {totalModels === 1 ? "group is" : "groups are"} on this page.</p>
        ) : null}
      </section>
      <BatchRunner candidates={queue.rows} batchSize={settings.batchSize} />
    </>
  );
}
