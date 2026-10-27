"use client";

import { useState } from "react";

/**
 * Separate from research queue export: this picker changes only which fleet
 * machines contribute cached model-BOM MPNs to a read-only shared research ZIP.
 */
export function FleetMpnExport({ statuses }: { statuses: string[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (status: string, checked: boolean) =>
    setSelected((current) => checked ? [...current, status] : current.filter((x) => x !== status));

  return <section className="card mb-4 p-3 text-sm">
    <div className="flex flex-wrap items-center gap-3">
      <div className="mr-auto">
        <h2 className="font-semibold">Fleet-wide MPN research export</h2>
        <p className="mt-1 text-xs text-muted">
          Independent of donor eligibility, qualification, prior research and family filters.
          Uses saved model parts lists for machines with the statuses you select, including sold or scrapped history.
        </p>
      </div>
      <a className="btn btn-primary" href="/api/export/fleet-mpns?all=1">Export ALL machine statuses (ZIP)</a>
    </div>
    <form className="mt-3 border-t border-line pt-3" action="/api/export/fleet-mpns" method="get">
      <input type="hidden" name="scope" value="selected" />
      <input type="hidden" name="all" value="1" />
      <fieldset>
        <legend className="mb-2 font-medium">Or choose one or more machine statuses</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {statuses.map((status) => <label key={status} className="flex items-center gap-2">
            <input type="checkbox" name="status" value={status}
              checked={selected.includes(status)} onChange={(event) => toggle(status, event.target.checked)} />
            <span>{status}</span>
          </label>)}
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" className="btn" disabled={selected.length === 0}>Export selected statuses (ZIP)</button>
        <span className="text-xs text-muted">{selected.length} selected · Duplicate MPNs appear once · CSVs are split into import-compatible batches</span>
      </div>
    </form>
    <p className="mt-2 text-xs text-muted">
      Exports show model fitment, not confirmed stock. Machines without saved parts lists cannot contribute MPNs.
      Neither export changes the research queue or machine status.
    </p>
  </section>;
}
