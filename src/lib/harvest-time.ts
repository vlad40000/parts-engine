import { canonicalizeMpn, displayMpn } from "./mpn";

export const HARVEST_TIME_MESSAGES = {
  machine: "Enter a valid machine ID.",
  date: "Enter a valid observation date.",
  minutes: "Times must be numbers in minutes, up to two decimals.",
  range: "Times must be between 0 and 1440 minutes.",
  rows: "Enter 1–30 component rows.",
  columns: "Use one row per part: MPN, removal minutes, test minutes.",
  mpn: "Each row requires an exact MPN.",
  duplicate: "Duplicate MPN in one harvest session, including displayed aliases of the same part.",
  duration: "Record at least one nonzero measured duration.",
  bom: "A selected MPN is not on this machine's completed exact-MPN parts list, or the machine needs nameplate verification.",
  unavailable: "Harvest measurements are unavailable until the application administrator applies the pending database update. Other Settings remain available.",
  error: "Harvest measurements could not be loaded or saved because of a database error. Try again; if it continues, contact the application administrator."
} as const;
export type HarvestTimeIssue = keyof typeof HARVEST_TIME_MESSAGES;
export class HarvestTimeValidationError extends Error {
  constructor(public readonly issue: Exclude<HarvestTimeIssue, "unavailable" | "error">) {
    super(HARVEST_TIME_MESSAGES[issue]);
  }
}
/** Read driver codes through Drizzle's cause wrapper; never expose raw database errors. */
export function harvestTimeIssue(error: unknown): HarvestTimeIssue {
  if (error instanceof HarvestTimeValidationError) return error.issue;
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const e = error as { code?: string; message?: string; cause?: unknown };
    if ((e.code === "42P01" || e.code === "42703") && /harvest_time_|mpn_display/.test(e.message ?? "")) return "unavailable";
    error = e.cause;
  }
  return "error";
}
export function harvestTimeMessage(issue: string | undefined): string | null {
  return issue && Object.hasOwn(HARVEST_TIME_MESSAGES, issue)
    ? HARVEST_TIME_MESSAGES[issue as HarvestTimeIssue] : null;
}
export type TimedPart = { mpnCanonical: string; mpnDisplay: string; removalMin: number; testMin: number };
export type HarvestSessionInput = {
  machineNo: string; observedOn: string; sharedAccessMin: number; parts: TimedPart[];
};
/** One measured harvest session; access time is recorded only once per machine session. */
export function parseHarvestSession(fields: {
  machineNo: string; observedOn: string; sharedAccessMin: string; partLines: string;
}): HarvestSessionInput {
  const machineNo = fields.machineNo.trim();
  if (!machineNo || machineNo.length > 80) throw new HarvestTimeValidationError("machine");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.observedOn) || fields.observedOn.startsWith("0000")) throw new HarvestTimeValidationError("date");
  const date = new Date(`${fields.observedOn}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== fields.observedOn) {
    throw new HarvestTimeValidationError("date");
  }
  const minutes = (raw: string): number => {
    if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(raw.trim())) throw new HarvestTimeValidationError("minutes");
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < 0 || n > 1440) throw new HarvestTimeValidationError("range");
    return n;
  };
  const sharedAccessMin = minutes(fields.sharedAccessMin);
  const lines = fields.partLines.split(/\r?\n/).map((l)=>l.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 30) throw new HarvestTimeValidationError("rows");
  const parts = lines.map((line): TimedPart => {
    const cols=line.split(",").map((s)=>s.trim());
    if (cols.length!==3) throw new HarvestTimeValidationError("columns");
    const mpnCanonical=canonicalizeMpn(cols[0]);
    if (!mpnCanonical || mpnCanonical.length>100 || cols[0].length>200) throw new HarvestTimeValidationError("mpn");
    return {mpnCanonical, mpnDisplay:displayMpn(cols[0]), removalMin:minutes(cols[1]), testMin:minutes(cols[2])};
  });
  if (new Set(parts.map((p)=>p.mpnCanonical)).size!==parts.length) throw new HarvestTimeValidationError("duplicate");
  if (sharedAccessMin===0 && parts.every((p)=>p.removalMin===0 && p.testMin===0)) throw new HarvestTimeValidationError("duration");
  return {machineNo, observedOn:fields.observedOn, sharedAccessMin, parts};
}
/** Informational allocation only: not transferred to operational economics. */
export function allocatedAccessMin(shared:number, count:number):number|null{
  return count>0 ? shared/count : null;
}
