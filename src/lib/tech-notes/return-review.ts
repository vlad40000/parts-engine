/**
 * A prior SOLD record is not proof the unit stayed sold. A dated observation
 * putting it at a physical shop location or describing an on-lot status may
 * represent a return. This is a candidate for physical verification, not a
 * decision to reverse the sale. Imported SOLD records can lack actual sale dates.
 */
export function isReturnCandidate(currentStatus: string, observedLocation: string | null | undefined, observedStatus: string | null | undefined): boolean {
  if (currentStatus.trim().toUpperCase() !== "SOLD") return false;
  const location = (observedLocation ?? "").trim().toLowerCase();
  const offLot = ["$$$sold$$$", "sold", "scraped", "scrapped", "off lot", "off-lot"];
  if (location && !offLot.includes(location)) return true;
  const status = (observedStatus ?? "").trim().toUpperCase();
  return ["UNCHECKED", "NEEDS PARTS", "PARTS ONLY", "PARTS PROGRAM", "BEING REPAIRED", "READY TO SALE"].includes(status);
}
