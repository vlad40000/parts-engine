import { brandKey, isUnreadableModel, modelKey } from "@/src/lib/model-key";
import { exactDiagramModel } from "@/src/lib/model-diagrams";
import { fleetMachines, modelBomCache, modelDiagrams } from "./schema";
import type { Db } from "./types";

export const DIAGRAM_COVERAGE_PAGE_SIZE = 100;

/** Read the entire fleet independently of the donor eligibility rules. */
export async function diagramCoverage(db: Db, status?: string, offset = 0) {
  const [machines, diagrams, leads] = await Promise.all([
    db.select({ machineNo: fleetMachines.machineNo, brand: fleetMachines.brand, model: fleetMachines.modelRaw,
      status: fleetMachines.availability, identity: fleetMachines.identityStatus }).from(fleetMachines),
    db.select({ brand: modelDiagrams.brandKey, model: modelDiagrams.exactModel }).from(modelDiagrams),
    db.select({ brand: modelBomCache.brandKey, model: modelBomCache.modelKey,
      source: modelBomCache.source, url: modelBomCache.sourceUrl }).from(modelBomCache)
  ]);
  const saved = new Set(diagrams.map((d) => JSON.stringify([d.brand, d.model])));
  const leadMap = new Map(leads.map((lead) => [JSON.stringify([lead.brand, lead.model]), lead]));
  const statuses = [...new Set(machines.map((m) => m.status))].sort();
  const groups = new Map<string, { brand: string; model: string; covered: boolean; machines: string[];
    statuses: Record<string, number>; lead: { source: string | null; url: string } | null }>();
  const nameplates: typeof machines = [];
  for (const m of machines) {
    if (status && m.status !== status) continue;
    const brand = brandKey(m.brand), model = exactDiagramModel(m.model);
    if (m.identity !== "ok" || !brand || isUnreadableModel(m.brand) || isUnreadableModel(model)) {
      nameplates.push(m);
      continue;
    }
    const key = JSON.stringify([brand, model]);
    let group = groups.get(key);
    if (!group) {
      const candidate = leadMap.get(JSON.stringify([brand, modelKey(model)]));
      let url: string | null = null;
      try { const parsed = new URL(candidate?.url ?? ""); if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed.href; } catch { /* no usable lead */ }
      group = { brand, model, covered: saved.has(key), machines: [], statuses: {},
        lead: url ? { source: candidate?.source ?? null, url } : null };
      groups.set(key, group);
    }
    group.machines.push(m.machineNo);
    group.statuses[m.status] = (group.statuses[m.status] ?? 0) + 1;
  }
  const all = [...groups.values()].sort((a, b) => Number(a.covered) - Number(b.covered) || b.machines.length - a.machines.length || a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset / DIAGRAM_COVERAGE_PAGE_SIZE) * DIAGRAM_COVERAGE_PAGE_SIZE : 0);
  return { statuses, totalMachines: all.reduce((n, g) => n + g.machines.length, 0) + nameplates.length,
    totalGroups: all.length, coveredGroups: all.filter((g) => g.covered).length,
    coveredMachines: all.filter((g) => g.covered).reduce((n, g) => n + g.machines.length, 0),
    nameplates, offset: safeOffset, rows: all.slice(safeOffset, safeOffset + DIAGRAM_COVERAGE_PAGE_SIZE) };
}
