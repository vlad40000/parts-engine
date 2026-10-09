import { NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { researchQueueCsvRows } from "@/src/db/queries";
import { buildSharedResearchCsv } from "@/src/lib/shared-research-csv";

export const dynamic = "force-dynamic";

/**
 * The research queue as the shared research CSV, the same file EbayDecisions imports and exports
 * (Settings → Shared research CSV). New Price is Parts Engine's new_price_min when known; the
 * research columns are left blank for the operator to fill in, then the completed file is
 * imported here or in EbayDecisions without conversion.
 */
export async function GET() {
  const rows = await researchQueueCsvRows(await getDb());
  const csv = buildSharedResearchCsv(rows.map((r) => ({
    mpnCanonical: r.mpn_canonical,
    mpnDisplay: r.mpn_display,
    description: r.description,
    notes: `Parts Engine: ${r.donors} donor machine(s) across ${r.models} model(s); family ${r.part_family}` +
      (r.market === "stale" ? "; research is stale" : ""),
    newPrice: r.new_price_min
  })));
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="research-queue-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}
