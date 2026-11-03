import { NextResponse } from "next/server";
import { getDb, hasDatabase } from "@/src/db";
import { machineDetail } from "@/src/db/queries";
import { machinePartsCsv } from "@/src/lib/machine-parts-export";

export const dynamic = "force-dynamic";

/** Download every saved part for exactly one fleet machine, without eligibility filtering. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!hasDatabase()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });

  const { id } = await context.params;
  let machineNo: string;
  try {
    machineNo = decodeURIComponent(id);
  } catch {
    return NextResponse.json({ error: "Invalid machine ID." }, { status: 400 });
  }
  if (!machineNo.trim()) {
    return NextResponse.json({ error: "Machine ID is required." }, { status: 400 });
  }

  const detail = await machineDetail(await getDb(), machineNo);
  if (!detail) return NextResponse.json({ error: "Machine not found." }, { status: 404 });
  if (detail.bom?.status !== "found" || !detail.parts.length) {
    return NextResponse.json({
      error: "No saved parts list is available for this machine. Retrieve its model's parts list first."
    }, { status: 409 });
  }

  // No donor status, qualification, market research, prefilter, or physical-state filters.
  const csv = machinePartsCsv(detail);
  const safeId = machineNo.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="machine-${safeId}-all-parts-${date}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
