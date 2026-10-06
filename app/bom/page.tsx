import { hasDatabase, getDb } from "@/src/db";
import { fleetFacets, getSettings, modelsNeedingBom } from "@/src/db/queries";
import { DEFAULT_AGE_BANDS } from "@/src/lib/serial-decoder";
import { BatchRunner } from "@/src/components/batch-runner";
import { NoDatabase, PageTitle } from "@/src/components/ui";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | undefined>>;

export default async function BomPage({ searchParams }: { searchParams: SP }) {
  if (!hasDatabase()) return <NoDatabase />;
  const sp = await searchParams;
  const db = await getDb();
  const settings = await getSettings(db);
  const filter = { band: sp.band, type: sp.type, brand: sp.brand };
  const [candidates, facets] = await Promise.all([modelsNeedingBom(db, filter, settings.donorAvailabilities, 300), fleetFacets(db)]);

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
      <BatchRunner candidates={candidates} batchSize={settings.batchSize} />
    </>
  );
}
