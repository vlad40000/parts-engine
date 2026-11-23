import { brandKey, isUnreadableModel, modelKey } from "@/src/lib/model-key";
import { exactDiagramModel } from "@/src/lib/model-diagrams";
import { canonicalizeMpn } from "@/src/lib/mpn";
import { isDiagramTableMissing } from "./model-diagrams";
import { fleetMachines, modelBomCache, modelDiagrams } from "./schema";
import type { Db } from "./types";

export const DIAGRAM_COVERAGE_PAGE_SIZE = 100;

type Coverage = "usable" | "diagram_only" | "needs_review" | "awaiting" | "unavailable";

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Saved JSON is evidence, so malformed or incomplete records need review, not coverage. */
function classifyEvidence(evidence: unknown): Coverage {
  if (!evidence || typeof evidence !== "object" || !("sections" in evidence) || !Array.isArray(evidence.sections) || !evidence.sections.length) return "needs_review";
  const sections: unknown[] = evidence.sections;
  let imageOnly = false;
  let incomplete = false;
  for (const item of sections) {
    if (!item || typeof item !== "object") { incomplete = true; continue; }
    const section = item as Record<string, unknown>;
    if (typeof section.assembly !== "string" || !section.assembly.trim() || !httpUrl(section.imageUrl) || !Array.isArray(section.parts)) {
      incomplete = true;
      continue;
    }
    if (!section.parts.length) { imageOnly = true; continue; }
    for (const part of section.parts) {
      if (part && typeof part === "object" && typeof part.callout === "string" && part.callout.trim() &&
          typeof part.partNumber === "string" && canonicalizeMpn(part.partNumber)) return "usable";
      incomplete = true;
    }
  }
  return imageOnly && !incomplete ? "diagram_only" : "needs_review";
}

/** Read the entire fleet independently of the donor eligibility rules. */
export async function diagramCoverage(db: Db, status?: string, offset = 0) {
  const [machines, diagrams, leads] = await Promise.all([
    db.select({ machineNo: fleetMachines.machineNo, brand: fleetMachines.brand, model: fleetMachines.modelRaw,
      status: fleetMachines.availability, identity: fleetMachines.identityStatus }).from(fleetMachines),
    db.select({ brand: modelDiagrams.brandKey, model: modelDiagrams.exactModel, evidence: modelDiagrams.evidence }).from(modelDiagrams)
      .catch((error: unknown) => { if (isDiagramTableMissing(error)) return null; throw error; }),
    db.select({ brand: modelBomCache.brandKey, model: modelBomCache.modelKey,
      source: modelBomCache.source, url: modelBomCache.sourceUrl, modelDisplay: modelBomCache.modelDisplay }).from(modelBomCache)
  ]);
  const saved = new Map(diagrams?.map((d) => [JSON.stringify([d.brand, d.model]), classifyEvidence(d.evidence)]) ?? []);
  const leadMap = new Map(leads.map((lead) => [JSON.stringify([lead.brand, lead.model]), lead]));
  const statuses = [...new Set(machines.map((m) => m.status))].sort();
  const groups = new Map<string, { brand: string; model: string; coverage: Coverage; machines: string[];
    statuses: Record<string, number>; lead: { source: string | null; url: string; exactRequest: boolean } | null }>();
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
      const url = httpUrl(candidate?.url);
      group = { brand, model, coverage: diagrams === null ? "unavailable" : saved.get(key) ?? "awaiting", machines: [], statuses: {},
        lead: url && candidate ? { source: candidate.source, url, exactRequest: exactDiagramModel(candidate.modelDisplay) === model } : null };
      groups.set(key, group);
    }
    group.machines.push(m.machineNo);
    group.statuses[m.status] = (group.statuses[m.status] ?? 0) + 1;
  }
  const all = [...groups.values()].sort((a, b) => Number(a.coverage === "usable") - Number(b.coverage === "usable") || b.machines.length - a.machines.length || a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset / DIAGRAM_COVERAGE_PAGE_SIZE) * DIAGRAM_COVERAGE_PAGE_SIZE : 0);
  return { statuses, totalMachines: all.reduce((n, g) => n + g.machines.length, 0) + nameplates.length,
    totalGroups: all.length, coverageAvailable: diagrams !== null,
    coveredGroups: diagrams === null ? null : all.filter((g) => g.coverage === "usable").length,
    coveredMachines: diagrams === null ? null : all.filter((g) => g.coverage === "usable").reduce((n, g) => n + g.machines.length, 0),
    savedGroups: diagrams === null ? null : all.filter((g) => g.coverage !== "awaiting").length,
    nameplates, offset: safeOffset, rows: all.slice(safeOffset, safeOffset + DIAGRAM_COVERAGE_PAGE_SIZE) };
}
