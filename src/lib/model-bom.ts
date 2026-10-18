import { and, eq } from "drizzle-orm";
import { getSettings, saveModelBom, type SavedModelBom } from "@/src/db/queries";
import * as t from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import type { FleetRow } from "@/src/lib/fleet-import";
import { isEligibleDonorStatus } from "@/src/lib/donor-status";
import { brandKey, modelKey } from "@/src/lib/model-key";
import { lookupModelBom, type ChainResult } from "@/src/sources/chain";
import { createFetcher } from "@/src/sources/http";
import type { Fetcher, ModelQuery } from "@/src/sources/types";

// One fetcher per server instance so the per-supplier politeness gate is shared
// by every model in a batch and by single-machine adds.
export const supplierFetcher = createFetcher({ concurrency: 2, minGapMs: 600, timeoutMs: 20_000 });

/** Run the supplier chain for one brand + model and persist the result through saveModelBom. */
export async function readModelBom(
  db: Db,
  { brand, model }: ModelQuery,
  fetcher: Fetcher = supplierFetcher
): Promise<{ result: ChainResult; saved: SavedModelBom }> {
  const result = await lookupModelBom({ brand, model }, fetcher);
  const saved = await saveModelBom(db, {
    brandKey: brandKey(brand),
    modelKey: modelKey(model),
    brandDisplay: brand,
    modelDisplay: model,
    result
  });
  return { result, saved };
}

export type MachineBom =
  | { outcome: "needs_nameplate" }
  | { outcome: "ineligible_status" }
  | { outcome: "cached"; rows: number }
  | { outcome: "looked_up"; status: ChainResult["status"]; rows: number };

/**
 * BOM identity is brand + model only; serial never selects or varies it.
 * A cached `found` BOM is reused as-is. Otherwise a readable model is looked up once
 * and saved. Unreadable models are never looked up.
 */
export async function ensureMachineBom(
  db: Db,
  machine: Pick<FleetRow, "brand" | "brandKey" | "modelRaw" | "modelKey" | "identityStatus" | "availability">,
  fetcher: Fetcher = supplierFetcher
): Promise<MachineBom> {
  if (machine.identityStatus !== "ok" || !machine.modelKey) return { outcome: "needs_nameplate" };
  if (!isEligibleDonorStatus(machine.availability, (await getSettings(db)).donorAvailabilities)) return { outcome: "ineligible_status" };
  const [cached] = await db.select().from(t.modelBomCache)
    .where(and(eq(t.modelBomCache.brandKey, machine.brandKey), eq(t.modelBomCache.modelKey, machine.modelKey)));
  if (cached?.status === "found") return { outcome: "cached", rows: cached.rowCount };
  const { result, saved } = await readModelBom(db, { brand: machine.brand, model: machine.modelRaw }, fetcher);
  return { outcome: "looked_up", status: result.status, rows: saved.rows };
}
