import evidence from "@/src/data/removal-repair-evidence.json";

export type PublishedReference = {
  id: string; appliance: string; component: string; brand: string; model: string;
  time_kind: string; repair_min_min: number | null; repair_min_max: number | null;
  harvest_min: null; source_title: string; source_url: string; source_quality: string; note: string;
};
/** Read-only repair references: never used by operational removal resolution. */
export const PUBLISHED_REPAIR_REFERENCES = evidence.publishedReferences as PublishedReference[];
export const REPAIR_REFERENCE_WARNING = "Published repair/replacement times are NOT measured harvest removal times and do not affect break-even or qualification.";
export function referencesFor(appliance: string, component: string): PublishedReference[] {
  return PUBLISHED_REPAIR_REFERENCES.filter((r) => r.appliance === appliance && r.component === component);
}
