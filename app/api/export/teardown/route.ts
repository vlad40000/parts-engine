import { NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { teardownQueue } from "@/src/db/queries";
import { toCsv } from "@/src/lib/csv";

export const dynamic = "force-dynamic";

/**
 * Yard pick list: one line per QUALIFIED part to pull, machines in teardown order.
 * Header only while the qualification rules are unset.
 */
export async function GET() {
  const { rows } = await teardownQueue(await getDb(), 500);
  const money = (n: number | null) => (n == null ? "" : n.toFixed(2));
  const lines = rows.flatMap((m, i) => [
    ...m.lines.map((l) => [i + 1, m.machine_no, m.brand, m.model_raw, l.mpn_display, l.description, l.diagram_id, l.removal_min ?? "",
      money(l.break_even), money(l.contribution), l.margin_pct ?? "", l.modeled_value_slot_day ?? "", "pull"]),
    ...m.suspect_lines.map((l) => [i + 1, m.machine_no, m.brand, m.model_raw, l.mpn_display, l.description, l.diagram_id, l.removal_min ?? "",
      money(l.break_even), money(l.contribution), l.margin_pct ?? "", l.modeled_value_slot_day ?? "", "test first: matches failure symptom"])
  ]);
  const csv = toCsv([
    "order", "machine", "brand", "model", "mpn", "description", "diagram", "removal_min",
    "break_even", "projected_contribution", "projected_margin_pct", "modeled_value_slot_day", "action"
  ], lines);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pick-list-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}
