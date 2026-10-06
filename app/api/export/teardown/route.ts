import { NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { teardownQueue } from "@/src/db/queries";
import { toCsv } from "@/src/lib/csv";

export const dynamic = "force-dynamic";

/** Yard pick list: one line per part to pull, machines in score order. */
export async function GET() {
  const { rows } = await teardownQueue(await getDb(), 500);
  const lines = rows.flatMap((m, i) => [
    ...m.lines.map((l) => [i + 1, m.machine_no, m.brand, m.model_raw, l.mpn_display, l.description, l.diagram_id, l.removal_min ?? "", l.profit.toFixed(2), "pull"]),
    ...m.suspect_lines.map((l) => [i + 1, m.machine_no, m.brand, m.model_raw, l.mpn_display, l.description, l.diagram_id, l.removal_min ?? "", l.profit.toFixed(2), "test first: matches failure symptom"])
  ]);
  const csv = toCsv(["rank", "machine", "brand", "model", "mpn", "description", "diagram", "removal_min", "profit", "action"], lines);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pick-list-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}
