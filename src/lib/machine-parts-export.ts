import type { machineDetail } from "@/src/db/queries";
import { spreadsheetCell, toCsv } from "./csv";

type MachineDetail = NonNullable<Awaited<ReturnType<typeof machineDetail>>>;

/**
 * Minimal shop-floor CSV: all saved model parts, including unresearched, skipped,
 * unqualified and pulled/missing parts. Omitting columns never removes their
 * underlying machine, part, qualification, state or sales records from Parts Engine.
 */
export function machinePartsCsv(detail: MachineDetail): string {
  const { machine, parts } = detail;
  const headers = [
    "Machine ID", "Brand", "Model", "Serial", "Physical Location",
    "MPN", "Description", "Test First", "Removal Minutes"
  ];

  const rows = parts.map((part) => [
    machine.machineNo, machine.brand, machine.modelRaw, machine.serial,
    machine.location ?? "", part.mpn_display, part.description,
    part.suspect ? "test first" : "", part.removal.minutes ?? ""
  ].map(spreadsheetCell));

  return toCsv(headers, rows);
}
