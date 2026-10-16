/** Client-safe choices; an explicit alternate never falls back to Encompass. */
export const BOM_SOURCE_IDS = ["auto", "alternatives", "partsdr", "partselect"] as const;
export type BomSource = typeof BOM_SOURCE_IDS[number];
export const BOM_SOURCE_LABELS: Record<BomSource, string> = {
  auto: "Original sources (Encompass → AppliancePartsPros)",
  alternatives: "Automatic — skip Encompass",
  partsdr: "Parts Dr",
  partselect: "PartSelect"
};
