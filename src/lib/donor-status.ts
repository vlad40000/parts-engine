/** Off-lot machines cannot supply a part, even if an older settings row contains the status. */
export const OFF_LOT_DONOR_STATUSES = ["SOLD", "SCRAPED", "SCRAPPED"] as const;

const offLot = new Set<string>(OFF_LOT_DONOR_STATUSES);
export const DEFAULT_CHECKED_DONOR_STATUSES = ["PARTS ONLY", "NEEDS PARTS", "PARTS PROGRAM"] as const;

export function isOffLotDonorStatus(status: string): boolean {
  return offLot.has(status.trim().toUpperCase());
}

export function eligibleDonorStatuses(configured: string[]): string[] {
  return [...new Set(configured.map((status) => status.trim().toUpperCase()).filter((status) => status && !offLot.has(status)))];
}

/** Unchecked machines require an explicit status selection for a BOM run or donor view. */
export function defaultDonorStatuses(configured: string[]): string[] {
  const checked = eligibleDonorStatuses(configured).filter((status) => status !== "UNCHECKED");
  return checked.length ? checked : [...DEFAULT_CHECKED_DONOR_STATUSES];
}

/** UNCHECKED is an explicit opt-in even when absent from the saved checked-donor configuration. */
export function selectedDonorStatuses(configured: string[], includeUnchecked: boolean): string[] {
  const checked = defaultDonorStatuses(configured);
  return includeUnchecked ? [...checked, "UNCHECKED"] : checked;
}

/** A BOM run requires an explicit selection from imported machine statuses. */
export function donorStatusesForSelection(configured: string[], selection?: string): string[] {
  if (!selection) return [];
  if (selection === "include_unchecked") return selectedDonorStatuses(configured, true);
  const status = selection.trim().toUpperCase();
  return status && !isOffLotDonorStatus(status) ? [status] : [];
}

export function isEligibleDonorStatus(status: string, configured: string[], includeUnchecked = false): boolean {
  const normalized = status.trim().toUpperCase();
  return selectedDonorStatuses(configured, includeUnchecked).includes(normalized);
}
