import { canonicalizeMpn } from "./mpn";
export type TimedPart = { mpnCanonical: string; removalMin: number; testMin: number };
export type HarvestSessionInput = {
  machineNo: string; observedOn: string; sharedAccessMin: number; parts: TimedPart[];
};
/** One measured harvest session; access time is recorded only once per machine session. */
export function parseHarvestSession(fields: {
  machineNo: string; observedOn: string; sharedAccessMin: string; partLines: string;
}): HarvestSessionInput {
  const machineNo = fields.machineNo.trim();
  if (!machineNo || machineNo.length > 80) throw new Error("Enter a valid machine ID.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.observedOn)) throw new Error("Enter a valid observation date.");
  const date = new Date(`${fields.observedOn}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== fields.observedOn) {
    throw new Error("Enter a valid observation date.");
  }
  const minutes = (raw: string): number => {
    if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(raw.trim())) throw new Error("Times must be numbers in minutes, up to two decimals.");
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < 0 || n > 1440) throw new Error("Times must be between 0 and 1440 minutes.");
    return n;
  };
  const sharedAccessMin = minutes(fields.sharedAccessMin);
  const lines = fields.partLines.split(/\r?\n/).map((l)=>l.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 30) throw new Error("Enter 1–30 component rows.");
  const parts = lines.map((line): TimedPart => {
    const cols=line.split(",").map((s)=>s.trim());
    if (cols.length!==3) throw new Error("Use one row per part: MPN, removal minutes, test minutes.");
    const mpnCanonical=canonicalizeMpn(cols[0]);
    if (!mpnCanonical || mpnCanonical.length>100) throw new Error("Each row requires an exact MPN.");
    return {mpnCanonical, removalMin:minutes(cols[1]), testMin:minutes(cols[2])};
  });
  if (new Set(parts.map((p)=>p.mpnCanonical)).size!==parts.length) throw new Error("Duplicate MPN in one harvest session.");
  if (sharedAccessMin===0 && parts.every((p)=>p.removalMin===0 && p.testMin===0)) throw new Error("Record at least one nonzero measured duration.");
  return {machineNo, observedOn:fields.observedOn, sharedAccessMin, parts};
}
/** Informational allocation only: not transferred to operational economics. */
export function allocatedAccessMin(shared:number, count:number):number|null{
  return count>0 ? shared/count : null;
}
