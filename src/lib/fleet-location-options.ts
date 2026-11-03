/** Standard Fleet location choices. Other preserves historical free-text placements. */
export const FLEET_LOCATION_OPTIONS = [
  "Red Building", "Shop", "Warehouse", "ICU", "Graveyard"
] as const;

export type FleetLocationChoice = (typeof FLEET_LOCATION_OPTIONS)[number] | "__other" | "__clear";

/** Unknown or legacy locations remain editable under Other, with their text intact. */
export function fleetLocationChoice(location: string | null): FleetLocationChoice | "" {
  if (!location) return "";
  return FLEET_LOCATION_OPTIONS.find((option) => option.toLowerCase() === location.trim().toLowerCase()) ?? "__other";
}

/** Invalid choices are rejected; __clear is an explicit action, not a shop location. */
export function resolveFleetLocationChoice(choice: string, other: string): string | null {
  if (choice === "__clear") return "";
  if (choice === "__other") return other.trim() || null;
  return FLEET_LOCATION_OPTIONS.find((option) => option === choice) ?? null;
}
