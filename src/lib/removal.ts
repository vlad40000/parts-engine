import seed from "@/src/data/removal-seed.json";
import { canonicalizeMpn } from "./mpn";
import { classifyComponent, type LibraryAppliance } from "./part-family";

export type RemovalSource = "observed" | "researched" | "generic" | "manual";
export type RemovalResolution = { minutes: number | null; source: RemovalSource | null; component: string | null };

export type Baseline = { appliance: string; component: string; minutes: number };

/** Researched exact-MPN overrides from the Store Economics Removal Time Library. */
export const SEED_OVERRIDES: ReadonlyMap<string, number> = new Map(
  seed.overrides.map((o) => [canonicalizeMpn(o.mpn), Number(o.minutes)])
);

export const SEED_BASELINES: Baseline[] = seed.generic.map((g) => ({
  appliance: g.appliance,
  component: g.component,
  minutes: Number(g.minutes)
}));

/**
 * D8 order: observed median → researched exact-MPN → generic component baseline.
 * Returns null minutes when nothing matches; greenlight then answers NEEDS_DATA.
 * There is deliberately no catch-all default (no invented minutes).
 */
export function resolveRemoval(input: {
  mpnCanonical: string;
  appliance: LibraryAppliance;
  description: string;
  storedMinutes?: number | null;
  storedSource?: string | null;
  baselines: Baseline[];
}): RemovalResolution {
  if (input.storedMinutes != null && input.storedSource && input.storedSource !== "generic") {
    return { minutes: input.storedMinutes, source: input.storedSource as RemovalSource, component: null };
  }
  const researched = SEED_OVERRIDES.get(input.mpnCanonical);
  if (researched != null) return { minutes: researched, source: "researched", component: null };

  const component = classifyComponent(input.appliance, input.description);
  if (component) {
    const hit = input.baselines.find((b) => b.appliance === input.appliance && b.component === component);
    if (hit) return { minutes: hit.minutes, source: "generic", component };
  }
  return { minutes: null, source: null, component };
}
