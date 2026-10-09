import { NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { researchQueueExport } from "@/src/db/queries";
import { SharedResearchExportError } from "@/src/lib/shared-research-csv";

export const dynamic = "force-dynamic";

/**
 * The research queue as the shared research CSV, the same file EbayDecisions imports and exports
 * (Settings → Shared research CSV). New Price is Parts Engine's new_price_min when known; the
 * research columns are left blank for the operator to fill in, then the completed file is
 * imported here or in EbayDecisions without conversion. One file is one batch of at most
 * SHARED_RESEARCH_MAX_ROWS queue rows; the MPNs page reports what a file leaves out.
 */
export async function GET() {
  try {
    const { csv } = await researchQueueExport(await getDb());
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="research-queue-${new Date().toISOString().slice(0, 10)}.csv"`
      }
    });
  } catch (error) {
    if (error instanceof SharedResearchExportError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
