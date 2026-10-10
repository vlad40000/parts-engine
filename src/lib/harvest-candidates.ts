/**
 * Physical harvest candidates for one MPN: which matched machines can this part be pulled
 * from right now. Uses physical facts only (identity, availability, part state, failure
 * symptom). It never looks at market facts, economic qualification or sales history; whether the
 * part is worth pulling is a separate decision.
 */
import { isEligibleDonorStatus } from "./donor-status";

export type MachineMatchRow = {
  machine_no: string; availability: string; appliance_type: string; brand: string; brand_key: string;
  model_raw: string; model_key: string; diagram_id: string; age_candidate_years: number[];
  suspect_families: string[]; identity_status: string; state: string | null;
};

export type HarvestStatus = "harvest_candidate" | "test_first" | "unavailable";

export type MachineMatch = MachineMatchRow & { candidate: HarvestStatus; reasons: string[] };

export type HarvestCandidates = {
  harvestCandidates: MachineMatch[];
  testFirst: MachineMatch[];
  unavailable: MachineMatch[];
  counts: { harvestCandidates: number; testFirst: number; unavailable: number; models: number };
};

export const HARVEST_LABEL: Record<HarvestStatus, string> = {
  harvest_candidate: "HARVEST CANDIDATE",
  test_first: "TEST FIRST",
  unavailable: "NOT CURRENTLY AVAILABLE"
};

export function classifyMachineMatch(row: MachineMatchRow, partFamily: string, donorAvailabilities: string[], includeUnchecked = false): MachineMatch {
  const reasons: string[] = [];
  if (row.identity_status !== "ok") reasons.push("Model unreadable: needs nameplate.");
  if (row.state) reasons.push(`Part already recorded as ${row.state} on this machine.`);
  if (!isEligibleDonorStatus(row.availability, donorAvailabilities, includeUnchecked)) reasons.push(`Availability ${row.availability} is not an eligible donor status.`);
  if (reasons.length) return { ...row, candidate: "unavailable", reasons };
  if (row.availability === "UNCHECKED") {
    return { ...row, candidate: "test_first", reasons: ["Machine is UNCHECKED; inspect and test this part before counting it."] };
  }
  if ((row.suspect_families ?? []).includes(partFamily)) {
    return { ...row, candidate: "test_first", reasons: [`Failure symptom flags ${partFamily}; test the part before counting it.`] };
  }
  return { ...row, candidate: "harvest_candidate", reasons: [] };
}

export function harvestCandidates(rows: MachineMatchRow[], partFamily: string, donorAvailabilities: string[], includeUnchecked = false): HarvestCandidates {
  const all = rows.map((r) => classifyMachineMatch(r, partFamily, donorAvailabilities, includeUnchecked));
  const of = (c: HarvestStatus) => all.filter((m) => m.candidate === c);
  const out = { harvestCandidates: of("harvest_candidate"), testFirst: of("test_first"), unavailable: of("unavailable") };
  return {
    ...out,
    counts: {
      harvestCandidates: out.harvestCandidates.length,
      testFirst: out.testFirst.length,
      unavailable: out.unavailable.length,
      models: new Set(rows.map((r) => `${r.brand_key}::${r.model_key}`)).size
    }
  };
}

/** Table and CSV share the same status-first order. */
export function machineMatchesByStatus(harvest: HarvestCandidates): MachineMatch[] {
  return [...harvest.harvestCandidates, ...harvest.testFirst, ...harvest.unavailable]
    .sort((a, b) => a.availability.localeCompare(b.availability) || a.machine_no.localeCompare(b.machine_no, undefined, { numeric: true }));
}
