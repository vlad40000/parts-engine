import { NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { researchQueueExport } from "@/src/db/queries";

export const dynamic = "force-dynamic";

/**
 * The research queue as the shared research CSV, the same file EbayDecisions imports and exports
 * (Settings → Shared research CSV). New Price is Parts Engine's new_price_min when known; the
 * research columns are left blank for the operator to fill in, then the completed file is
 * imported here or in EbayDecisions without conversion. One file is one batch of at most
 * SHARED_RESEARCH_MAX_ROWS queue rows; the MPNs page reports what a file leaves out.
 */
export async function GET() {
  const { csv } = await researchQueueExport(await getDb());
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="research-queue-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}
