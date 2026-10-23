/**
 * Human-editable machine availability states. Supplier BOM statuses (found/error)
 * are deliberately separate from this controlled vocabulary.
 * SCRAPED is a historic import spelling: still treated as off-lot but is not
 * offered for new edits; choose SCRAPPED instead.
 */
export const FLEET_STATUS_OPTIONS = [
  "UNCHECKED",
  "NEEDS PARTS",
  "PARTS ONLY",
  "PARTS PROGRAM",
  "READY TO SALE",
  "SOLD",
  "SCRAPPED"
] as const;

export type EditableFleetStatus = (typeof FLEET_STATUS_OPTIONS)[number];
export function isEditableFleetStatus(value: string): value is EditableFleetStatus {
  return (FLEET_STATUS_OPTIONS as readonly string[]).includes(value);
}
