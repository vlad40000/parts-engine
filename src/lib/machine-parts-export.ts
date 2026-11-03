import type { machineDetail } from "@/src/db/queries";
import { spreadsheetCell, toCsv } from "./csv";

type MachineDetail = NonNullable<Awaited<ReturnType<typeof machineDetail>>>;

/**
 * Export the complete saved per-machine parts table (including skipped, unresearched,
 * unqualified, pulled, failed, and missing parts). This is NOT a research queue,
 * a physical stock report, or the deduplicated fleet-wide MPN export.
 */
export function machinePartsCsv(detail: MachineDetail): string {
  const { machine, bom, parts } = detail;
  const headers = [
    "Machine ID", "Brand", "Model", "Serial", "Machine Status", "Physical Location",
    "Condition", "Parts List Source", "Parts List Retrieved At",
    "Diagram", "MPN", "Canonical MPN", "Description", "Part Family",
    "Test First", "Removal Minutes", "New Price", "Break-even",
    "Qualification", "Qualification Detail", "Roadrunner History (imported)",
    "Roadrunner Units Sold", "Roadrunner Sale Events", "Roadrunner Average Item Price",
    "Roadrunner Last Sold", "Roadrunner Sources", "Part State"
  ];

  const money = (value: number | string | null | undefined) =>
    value == null ? "" : Number(value).toFixed(2);
  const qualification = (part: MachineDetail["parts"][number]) => {
    if (part.prefilter && part.market === "missing") return "skipped";
    if (!part.qualification) return part.market === "missing" ? "not researched" : "";
    return part.qualification.result;
  };
  const qualificationDetail = (part: MachineDetail["parts"][number]) => {
    if (part.prefilter && part.market === "missing") return part.prefilter;
    const q = part.qualification;
    if (!q) return "";
    if (q.result === "SET_RULE") return q.missingRules.join("; ");
    if (q.result === "NEEDS_DATA") return q.missing.join("; ");
    return q.reasons.join("; ");
  };

  const rows = parts.map((part) => {
    const history = part.roadrunner;
    return [
      machine.machineNo, machine.brand, machine.modelRaw, machine.serial,
      machine.availability, machine.location ?? "", machine.condition ?? "",
      bom?.source ?? "", bom?.fetchedAt?.toISOString() ?? "",
      part.diagram_id, part.mpn_display, part.mpn_canonical, part.description,
      part.part_family, part.suspect ? "test first" : "",
      part.removal.minutes ?? "", money(part.new_price_min),
      money(part.qualification?.economics?.breakEven),
      qualification(part), qualificationDetail(part),
      history ? "Recorded sales" : "No recorded sales",
      history?.unitsSold ?? "", history?.saleEvents ?? "",
      money(history?.avgItemPrice), history?.lastSoldAt ?? "",
      history?.sources.join("; ") ?? "", part.state ?? ""
    ].map(spreadsheetCell);
  });
  return toCsv(headers, rows);
}
