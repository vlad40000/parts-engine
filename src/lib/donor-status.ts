/** Off-lot machines cannot supply a part, even if an older settings row contains the status. */
export const OFF_LOT_DONOR_STATUSES = ["SOLD", "SCRAPED", "SCRAPPED"] as const;

const offLot = new Set<string>(OFF_LOT_DONOR_STATUSES);

export function eligibleDonorStatuses(configured: string[]): string[] {
  return [...new Set(configured.map((status) => status.trim().toUpperCase()).filter((status) => status && !offLot.has(status)))];
}

/** Unchecked machines require an explicit status selection for a BOM run or donor view. */
export function defaultDonorStatuses(configured: string[]): string[] {
  return eligibleDonorStatuses(configured).filter((status) => status !== "UNCHECKED");
}

export function isEligibleDonorStatus(status: string, configured: string[], includeUnchecked = false): boolean {
  const normalized = status.trim().toUpperCase();
  return (includeUnchecked ? eligibleDonorStatuses(configured) : defaultDonorStatuses(configured)).includes(normalized);
}
