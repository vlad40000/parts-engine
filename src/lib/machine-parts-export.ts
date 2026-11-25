import type { machineDetail } from "@/src/db/queries";
import { spreadsheetCell, toCsv } from "./csv";

type MachineDetail = NonNullable<Awaited<ReturnType<typeof machineDetail>>>;

/** Prefixed to the CSV Description of a part kept only by its recorded state. The stored description is unchanged. */
export const HISTORICAL_DESCRIPTION_MARKER = "[HISTORICAL - not on current parts list]";

/**
 * A machine's parts CSV can be downloaded when its model has a found parts list with parts, or when it has
 * recorded part states that are not on a found list. The page control and the API guard both use this rule.
 */
export function machinePartsExportable(detail: Pick<MachineDetail, "bom" | "parts">): boolean {
  if (!detail.parts.length) return false;
  return detail.bom?.status === "found" || detail.parts.some((part) => part.historical);
}

/**
 * Minimal shop-floor CSV: all saved model parts, including unresearched, skipped,
 * unqualified and pulled/missing parts, plus parts with a recorded state whose MPN is not on
 * the current parts list (same nine columns; Description starts with HISTORICAL_DESCRIPTION_MARKER).
 * Omitting columns never removes their underlying machine, part, qualification, state or sales
 * records from Parts Engine.
 */
export function machinePartsCsv(detail: MachineDetail): string {
  const { machine, parts } = detail;
  const headers = [
    "Machine ID", "Brand", "Model", "Serial", "Physical Location",
    "MPN", "Description", "Test First", "Removal Minutes"
  ];

  const rows = parts.map((part) => [
    machine.machineNo, machine.brand, machine.modelRaw, machine.serial,
    machine.location ?? "", part.mpn_display,
    part.historical ? [HISTORICAL_DESCRIPTION_MARKER, part.description].filter(Boolean).join(" ") : part.description,
    part.suspect ? "test first" : "", part.removal.minutes ?? ""
  ].map(spreadsheetCell));

  return toCsv(headers, rows);
}
