import { NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { physicalReviewQueue, teardownQueue } from "@/src/db/queries";
import { spreadsheetCell, toCsv } from "@/src/lib/csv";

export const dynamic = "force-dynamic";

/**
 * Yard pick list: one line per QUALIFIED part to pull, machines in teardown order.
 * Without qualification rules, export a physical review list with no economic claims.
 */
export async function GET() {
  const db = await getDb();
  const { rows, status } = await teardownQueue(db, 500);
  if (status === "set_rule") {
    const header = ["machine", "status", "brand", "model", "mpn", "description", "diagram", "action", "location"];
    const headerCsv = toCsv(header, []);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(headerCsv));
        try {
          for (let offset = 0; ; offset += 500) {
            const physical = await physicalReviewQueue(db, 500, offset);
            if (!physical.length) break;
            const lines = physical.flatMap((m) => m.lines.map((l) => [m.machine_no, m.availability, m.brand, m.model_raw,
              l.mpn_display, l.description, l.diagram_id, l.action, m.location ?? ""].map(spreadsheetCell)));
            controller.enqueue(encoder.encode(toCsv(header, lines).slice(headerCsv.length)));
            if (physical.length < 500) break;
          }
          controller.close();
        } catch (error) { controller.error(error); }
      }
    });
    return new NextResponse(stream, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="physical-review-${new Date().toISOString().slice(0, 10)}.csv"`
    } });
  }
  const money = (n: number | null) => (n == null ? "" : n.toFixed(2));
  const lines = rows.flatMap((m, i) => [
    ...m.lines.map((l) => [i + 1, m.machine_no, m.brand, m.model_raw, l.mpn_display, l.description, l.diagram_id, l.removal_min ?? "",
      money(l.break_even), money(l.contribution), l.margin_pct ?? "", l.modeled_value_slot_day ?? "", "pull", m.location ?? ""]),
    ...m.suspect_lines.map((l) => [i + 1, m.machine_no, m.brand, m.model_raw, l.mpn_display, l.description, l.diagram_id, l.removal_min ?? "",
      money(l.break_even), money(l.contribution), l.margin_pct ?? "", l.modeled_value_slot_day ?? "", "test first: matches failure symptom", m.location ?? ""])
  ]);
  const csv = toCsv([
    "order", "machine", "brand", "model", "mpn", "description", "diagram", "removal_min",
    "break_even", "projected_contribution", "projected_margin_pct", "modeled_value_slot_day", "action", "location"
  ], lines.map((line) => line.map(spreadsheetCell)));
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pick-list-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}
