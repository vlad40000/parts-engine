import { NextResponse } from "next/server";
import { getDb, hasDatabase } from "@/src/db";
import { mpnDetail } from "@/src/db/queries";
import { toCsv } from "@/src/lib/csv";
import { machineMatchesByStatus } from "@/src/lib/harvest-candidates";

export const dynamic = "force-dynamic";

// A spreadsheet must not interpret imported machine text as a formula.
const cell = (value: unknown) => {
  const text = value == null ? "" : String(value);
  return /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text;
};

export async function GET(request: Request) {
  if (!hasDatabase()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  const url = new URL(request.url);
  const mpn = url.searchParams.get("mpn")?.trim();
  if (!mpn) return NextResponse.json({ error: "MPN is required." }, { status: 400 });
  const selected = url.searchParams.get("availability")?.trim().toUpperCase();
  const availability = selected === "ALL" ? "all" : selected === "INCLUDE_UNCHECKED" ? "include_unchecked"
    : selected === "ELIGIBLE" || !selected ? "eligible" : selected;
  const detail = await mpnDetail(await getDb(), mpn, availability);
  if (!detail) return NextResponse.json({ error: "MPN not found." }, { status: 404 });
  const matches = machineMatchesByStatus(detail.harvest);
  const csv = toCsv(
    ["MPN", "machine", "status", "candidate", "type", "brand", "model", "diagram", "possible_years", "part_state", "reason"],
    matches.map((m) => [detail.mpn.mpn_display, m.machine_no, m.availability, m.candidate, m.appliance_type,
      m.brand, m.model_raw, m.diagram_id, m.age_candidate_years.join("; "), m.state ?? "", m.reasons.join(" ")].map(cell))
  );
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="mpn-donors-${detail.mpn.mpn_canonical.replace(/[^A-Z0-9_-]/gi, "_")}-${availability.replace(/[^A-Z0-9_-]/gi, "_")}.csv"`
    }
  });
}
