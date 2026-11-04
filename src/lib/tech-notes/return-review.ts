/**
 * SOLD is not a terminal machine lifecycle. A photo of a physical shop
 * location or an inventory-ready status is a possible return, not proof of
 * when the unit was sold or returned.
 *
 * A stale SOLD location marker must keep the alert visible even if somebody
 * edits the status alone: both fields need a current physical confirmation.
 */
export const isSoldLocationMarker = (s: string | null | undefined) => {
  const value = (s ?? "").trim().toLowerCase();
  return value === "$$$sold$$$" || value === "sold" || value === "off lot" || value === "off-lot";
};
export function isReturnCandidate(
  currentStatus: string,
  observedLocation: string | null | undefined,
  observedStatus: string | null | undefined,
  currentLocation?: string | null
): boolean {
  const wasOffLot = currentStatus.trim().toUpperCase() === "SOLD" || isSoldLocationMarker(currentLocation);
  if (!wasOffLot) return false;
  const seen = (observedLocation ?? "").trim().toLowerCase();
  const onLotLocation = !!seen && !isSoldLocationMarker(seen) && seen !== "scrapped" && seen !== "graveyard";
  const status = (observedStatus ?? "").trim().toUpperCase();
  const onLotStatus = ["UNCHECKED", "NEEDS PARTS", "PARTS ONLY", "PARTS PROGRAM", "BEING REPAIRED", "READY TO SALE"].includes(status);
  return onLotLocation || onLotStatus;
}
