import { brandKey, isUnreadableModel, modelKey } from "./model-key";
import { decodeSerial } from "./serial-decoder";
import { suspectFamilies } from "./part-family";
import { cellText as text } from "./table-read";
import { readTable } from "./table-read";

/**
 * Allow-list import. Only the columns below are ever read, so purchaser name,
 * address and phone in the inventory workbook never enter this database.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  machineNo: ["id", "no", "no.", "machine id", "machine_id", "machine no", "unit", "unit #", "unit no"],
  availability: ["availability", "status"],
  applianceType: ["appliancetype", "appliance type", "type"],
  configuration: ["configuration", "config"],
  agitation: ["agitation"],
  brand: ["brand", "make"],
  model: ["modelnumber", "model number", "model", "model #"],
  serial: ["serialnumber", "serial number", "serial", "serial #"],
  color: ["color", "colour"],
  condition: ["condition"],
  location: ["location"],
  acquiredAt: ["dateacquired", "date acquired", "acquired"],
  diagnosis: ["diagnosis", "failure", "symptom", "primary failure"],
  repairNotes: ["repairnotes", "repair notes"],
  notes: ["notes", "review note", "review notes", "note"],
  listPrice: ["listprice", "list price", "retailprice", "retail price"]
};

export type FleetRow = {
  machineNo: string;
  availability: string;
  applianceType: string;
  configuration: string | null;
  brand: string;
  brandKey: string;
  modelRaw: string;
  modelKey: string;
  serial: string;
  color: string | null;
  condition: string | null;
  location: string | null;
  diagnosis: string | null;
  notes: string | null;
  listPrice: string | null;
  acquiredAt: string | null;
  identityStatus: "ok" | "needs_nameplate";
  suspectFamilies: string[];
  ageFamily: string | null;
  ageCandidateYears: number[];
  ageMonth: number | null;
  ageWeek: number | null;
  ageConfidence: "unique" | "ambiguous" | "none";
  ageNote: string;
};

export type FleetImportResult = {
  rows: FleetRow[];
  skipped: Array<{ line: number; reason: string }>;
  duplicates: string[];
  ignoredColumns: string[];
};

function norm(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function money(v: unknown): string | null {
  const t = text(v).replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

function isoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const t = text(v);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function normalizeAvailability(v: string): string {
  const t = v.trim().toUpperCase();
  return t || "UNCHECKED";
}

export function mapFleetRows(records: Array<Record<string, unknown>>, now: Date = new Date()): FleetImportResult {
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const lookup = new Map<string, string>();
  const used = new Set<string>();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    let header: string | undefined;
    for (const alias of aliases) {
      header = headers.find((h) => norm(h) === alias);
      if (header) break;
    }
    if (header) {
      lookup.set(field, header);
      used.add(header);
    }
  }
  const get = (r: Record<string, unknown>, field: string) => {
    const h = lookup.get(field);
    return h ? r[h] : undefined;
  };

  const rows: FleetRow[] = [];
  const skipped: FleetImportResult["skipped"] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  records.forEach((r, i) => {
    const line = i + 2;
    const machineNo = text(get(r, "machineNo"));
    if (!machineNo) {
      const anyValue = Object.values(r).some((v) => text(v));
      if (anyValue) skipped.push({ line, reason: "No machine ID." });
      return;
    }
    if (seen.has(machineNo)) {
      duplicates.push(machineNo);
      return;
    }
    seen.add(machineNo);

    const brand = text(get(r, "brand"));
    const modelRaw = text(get(r, "model"));
    const serial = text(get(r, "serial"));
    const applianceType = text(get(r, "applianceType"));
    const diagnosis = text(get(r, "diagnosis")) || null;
    const repairNotes = text(get(r, "repairNotes"));
    const notes = [text(get(r, "notes")), repairNotes].filter(Boolean).join(" | ") || null;
    const agitation = text(get(r, "agitation"));
    const configuration = [text(get(r, "configuration")), agitation].filter(Boolean).join(" / ") || null;

    const unreadable = isUnreadableModel(modelRaw) || !brand;
    const age = unreadable ? null : decodeSerial(brand, modelRaw, serial, now);

    rows.push({
      machineNo,
      availability: normalizeAvailability(text(get(r, "availability"))),
      applianceType,
      configuration,
      brand,
      brandKey: brandKey(brand),
      modelRaw,
      modelKey: unreadable ? "" : modelKey(modelRaw),
      serial,
      color: text(get(r, "color")) || null,
      condition: text(get(r, "condition")) || null,
      location: text(get(r, "location")) || null,
      diagnosis,
      notes,
      listPrice: money(get(r, "listPrice")),
      acquiredAt: isoDate(get(r, "acquiredAt")),
      identityStatus: unreadable ? "needs_nameplate" : "ok",
      suspectFamilies: suspectFamilies(diagnosis, repairNotes),
      ageFamily: age?.family ?? null,
      ageCandidateYears: age?.candidateYears ?? [],
      ageMonth: age?.month ?? null,
      ageWeek: age?.week ?? null,
      ageConfidence: age?.confidence ?? "none",
      ageNote: age?.note ?? "Model unreadable; identify from nameplate first."
    });
  });

  return {
    rows,
    skipped,
    duplicates,
    ignoredColumns: headers.filter((h) => !used.has(h))
  };
}

// ---------------------------------------------------------------------------
// File reader
// ---------------------------------------------------------------------------
const isFleetHeader = (cells: string[]) =>
  cells.filter((v) => Object.values(COLUMN_ALIASES).some((a) => a.includes(norm(v)))).length >= 3;

export async function readFleetFile(name: string, buffer: ArrayBuffer): Promise<Array<Record<string, unknown>>> {
  return readTable(name, buffer, isFleetHeader);
}

export { parseCsvRecords as parseCsv } from "./csv";
