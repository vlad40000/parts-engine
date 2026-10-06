import { NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { researchQueueCsvRows } from "@/src/db/queries";
import { toCsv } from "@/src/lib/csv";

export const dynamic = "force-dynamic";

/**
 * Columns match EbayDecisions /api/parts/import (mpn, description, notes), so the
 * file drops straight into its catalogue and its Research Queue picks the MPNs up.
 */
export async function GET() {
  const rows = await researchQueueCsvRows(await getDb());
  const csv = toCsv(
    ["mpn", "description", "notes"],
    rows.map((r) => [
      r.mpn_display,
      r.description,
      `Parts Engine: ${r.donors} donor machine(s) across ${r.models} model(s); family ${r.part_family}` +
        (r.new_price_min ? `; new $${Number(r.new_price_min).toFixed(2)}` : "") +
        (r.market === "stale" ? "; research is stale" : "")
    ])
  );
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="research-queue-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}
