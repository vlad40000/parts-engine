import { canonicalizeMpn } from "../../src/lib/mpn";
import { exactDiagramModel } from "../../src/lib/model-diagrams";
import ge from "./ge-catalog.json";
import supplier from "./ge-supplier.json";
// Reviewed callout-10 evidence for 6613, produced by the committed Maytag acquisition fixtures (docs/DIAGRAM_SOURCES.md).
import diagramEvidence from "../../test/fixtures/diagrams/results.json";

export interface FleetRecord {
  machine_no: string; availability: string; brand: string; model_raw: string; serial: string;
  identity_status: string; age_candidate_years: number[]; age_confidence: string;
  model_spellings: number; brand_display: string | null; model_display: string | null;
  cache_status: string | null; source: string | null; source_url: string | null;
  fetched_at: string | null; row_count: number | null; dropped_rows: number | null;
  edge_count: number; diagram_digest: string | null;
}

export interface CacheEdge {
  mpn_display: string; mpn_canonical: string; diagram_id: string; source: string;
  source_url: string | null; brand_display: string | null; model_display: string | null; cache_status: string | null;
}

export interface HistoryRow {
  machine_no: string; mpn_canonical: string; origin: string; edge_match: string;
  action: string; event_id: string | null; disposition: string | null; previous_disposition: string | null;
  sold_price: string | null; previous_sold_price: string | null; repair_machine_no: string | null;
  recorded_at: string; applied: boolean | null;
}

export interface Snapshot { audited_at: string; fleet: FleetRecord[]; ge: CacheEdge[]; history: HistoryRow[] }

const exact = (value: string | null) => exactDiagramModel(value ?? "");
const isGe = (r: FleetRecord) => exact(r.brand) === ge.brand && exact(r.model_raw) === ge.model;
const isMaytag = (r: FleetRecord) => exact(r.brand) === "MAYTAG" && exact(r.model_raw) === "MVW6230HW1";
const pilotIdentity = (r: FleetRecord) => isMaytag(r) && r.serial === "CA1304279";
// A serial field without a single digit is a note about the marking ("NO NAMEPLATE", "UNREADABLE", "WORE OFF",
// "DOOR LOCKED", "NEW"), not a serial. The literal value stays on the report.
const isSerialNote = (serial: string) => !/[0-9]/.test(serial);
const maytagOem = "https://assets.ajmadison.com/ajmadison/itemdocs/repair-parts-list-w11497934-revb.pdf#page=3";
const callout10 = diagramEvidence.machine6613;

type SupplierRow = { assembly: string; callout: string; mpn: string; d1: string; ap: string | null; description: string; source: string };
const supplierRows: SupplierRow[] = supplier.sections.flatMap(section => section.rows.map(([callout, mpn, ap, description]) => ({
  assembly: section.assembly, callout: String(callout), mpn: String(mpn), d1: canonicalizeMpn(mpn), ap: ap ?? null,
  description: String(description ?? ""), source: section.url
})));

function tally(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function geComparison(edges: CacheEdge[]) {
  const positions = ge.sections.flatMap(section => section.positions.map(([callout, mpn, replacement]) => ({
    assembly: section.assembly, callout, catalog_mpn: mpn, catalog_d1: canonicalizeMpn(mpn),
    replacement_mpn: replacement ?? null, replacement_d1: canonicalizeMpn(replacement) || null,
    source: section.url, reviewed_on: ge.reviewedOn
  })));
  const eligible = (e: CacheEdge) => e.cache_status === "found" && exact(e.brand_display) === ge.brand && exact(e.model_display) === ge.model;
  const candidateKeys = new Set(edges.filter(eligible).map(e => canonicalizeMpn(e.mpn_display)));
  const comparison = edges.map(edge => {
    const key = canonicalizeMpn(edge.mpn_display);
    const matches = eligible(edge) ? positions.filter(p => p.catalog_d1 === key || p.replacement_d1 === key) : [];
    const roles = [...new Set(matches.map(p => p.catalog_d1 === key ? "catalog" : "service replacement"))];
    const outcome = roles.join(" + ") || (eligible(edge) ? "absent from reviewed GE sections" : "cache identity unresolved");
    return { ...edge, printed_d1: key, outcome,
      oem_matches: matches.map(p => ({ ...p, same_section: exact(edge.diagram_id) === p.assembly })),
      live_supplier_positions: supplierRows.filter(r => r.d1 === key).map(r => `${r.assembly} #${r.callout}`),
      serial_applicability: "unresolved", harvested_identity: "unverified" };
  });
  // The supplier's number at the same drawn position is separate evidence. Agreement corroborates the OEM
  // transcription; a different number is a competing claim that stays visible, never a supersession.
  const supplierAt = (p: { assembly: string; callout: string }) =>
    supplierRows.filter(r => r.assembly === p.assembly && r.callout === p.callout);
  const supplierKeys = new Set(supplierRows.map(r => r.d1));
  return { comparison, supplierKeys, candidateKeys,
    supplierOnly: supplierRows.filter(r => !positions.some(p => p.assembly === r.assembly && p.callout === r.callout)),
    positions: positions.map(p => {
      const at = supplierAt(p);
      const agreement = [...new Set(at.map(r => r.d1 === p.catalog_d1 ? "catalog" : r.d1 === p.replacement_d1 ? "replacement" : "competing number"))];
      return { ...p,
        catalog_in_cache: candidateKeys.has(p.catalog_d1), replacement_in_cache: !!p.replacement_d1 && candidateKeys.has(p.replacement_d1),
        supplier_listed: at.map(r => r.mpn), supplier_agreement: agreement.join(" + ") || "not listed by supplier" };
    }) };
}

export function audit(snapshot: Snapshot) {
  const { fleet, history } = snapshot;
  if (new Set(fleet.map(r => r.machine_no)).size !== fleet.length) throw new Error("Duplicate Machine ID in audit input");
  // Fold case only for finding candidates. Raw serials remain on the report.
  const groupKey = (r: FleetRecord) => JSON.stringify([exact(r.brand), exact(r.model_raw), exact(r.serial)]);
  const groups = new Map<string, string[]>();
  for (const r of fleet.filter(r => r.serial.trim())) {
    const key = groupKey(r);
    const ids = groups.get(key) ?? [];
    ids.push(r.machine_no);
    groups.set(key, ids);
  }
  const primary = fleet.find(r => r.machine_no === "6613" && pilotIdentity(r));
  const confirmedPair = !!primary && fleet.some(r => r.machine_no === "6601" && pilotIdentity(r));
  const unmatched = tally(history.filter(h => h.edge_match !== "current edge").map(h => h.machine_no));
  const machines = fleet.map(r => {
    const modelBom = r.cache_status === "found" && (r.row_count ?? 0) > 0;
    const cacheLabel = !r.cache_status ? "no cache" : exact(r.brand_display) === exact(r.brand)
      && exact(r.model_display) === exact(r.model_raw) ? "labels agree" : "labels differ";
    const ids = groups.get(groupKey(r)) ?? [];
    const reasons = ["no reviewed machine-wide serial or common-production rule"];
    if (r.identity_status !== "ok") reasons.push("nameplate review");
    const serialEvidence = !r.serial.trim() ? "blank" : isSerialNote(r.serial) ? "placeholder" : "recorded";
    if (serialEvidence === "blank") reasons.push("missing serial");
    if (serialEvidence === "placeholder") reasons.push("serial field describes missing or unreadable marking");
    if (r.age_confidence === "ambiguous") reasons.push("ambiguous build date");
    if (ids.length > 1) reasons.push(serialEvidence === "placeholder" ? "repeated placeholder" : "repeated recorded identity");
    if (r.model_spellings > 1) reasons.push("multiple full identities under lookup key");
    if (!modelBom) reasons.push("no found nonempty model cache");
    if (cacheLabel === "labels differ") reasons.push("cache label mismatch");
    if (r.cache_status === "found" && r.edge_count !== r.row_count) reasons.push("cache count differs from stored edges");
    if (r.dropped_rows) reasons.push("supplier rows dropped");
    if (unmatched[r.machine_no]) reasons.push("part history outside current visible edges");
    const ownerUnit = primary === r || (confirmedPair && r.machine_no === "6601") ? "6613" : null;
    if (ownerUnit === "6613" && r.machine_no === "6601") reasons.push("confirmed duplicate of 6613");
    if (primary === r) reasons.push("callout 10 factory identity unresolved");
    const oemSource = isGe(r) ? ge.source : isMaytag(r) ? maytagOem : null;
    const soldGeCatalog = exact(r.brand) === "GE" && exact(r.model_raw) === "GSS25WGTABB";
    const supplierSource = isMaytag(r) ? "https://www.appliancepartspros.com/parts-for-whirlpool-mvw6230hw1.html"
      : soldGeCatalog ? "https://www.appliancepartspros.com/parts-for-ge-gss25wgtabb.html" : isGe(r) ? supplier.source : null;
    if (!oemSource && !supplierSource) reasons.push("exact parts-list source scope unreviewed");
    if (exact(r.brand) === "LG" && exact(r.model_raw) === "WT7200CW") reasons.push("manufacturer variation required by reviewed source");
    return { ...r, model_bom_found: modelBom, cache_label_match: cacheLabel,
      reviewed_exact_model_source: oemSource,
      // GE blocks scripted retrieval; its five sections were transcribed by hand with no raw page preserved.
      reviewed_oem_retrieval: isGe(r) ? "5 sections transcribed 2026-11-24; raw capture not preserved"
        : isMaytag(r) ? "5/5 sections in committed OEM fixture" : "unknown",
      reviewed_supplier_source: supplierSource, cache_retrieval_completeness: "unknown",
      reviewed_supplier_retrieval: isMaytag(r) ? "6/6 sections in APP snapshot; 2 unread callouts"
        : soldGeCatalog ? "9/9 sections in APP snapshot; 10 unread rows"
        : isGe(r) ? "5/5 sections re-read 2026-11-24 (ge-supplier.json)" : "unknown",
      variation: "unverified", serial_present: !!r.serial.trim(), serial_evidence: serialEvidence,
      repeated_identity_ids: ids.length > 1 ? ids : [],
      confirmed_physical_unit: ownerUnit, unmatched_history_rows: unmatched[r.machine_no] ?? 0,
      machine_applicability: "unresolved", verification: "documented exception", reasons };
  });
  const { comparison, positions, supplierOnly, supplierKeys, candidateKeys } = geComparison(snapshot.ge);
  const geMachines = machines.filter(isGe);
  const repeated = [...groups.values()].filter(ids => ids.length > 1);
  const summary = {
    snapshot_at: snapshot.audited_at, fleet_records: machines.length, by_status: tally(machines.map(r => r.availability)),
    found_nonempty_model_bom: machines.filter(r => r.model_bom_found).length,
    missing_model_bom: machines.filter(r => !r.model_bom_found).length,
    by_cache_status: tally(machines.map(r => r.cache_status ?? "no cache row")),
    fully_verified_with_reviewed_evidence: 0, documented_exceptions: machines.length,
    owner_confirmed_physical_units: primary ? 1 : 0, exhaustive_physical_unit_count: null,
    records_after_confirmed_duplicates: machines.length - Number(confirmedPair),
    nameplate_review: machines.filter(r => r.identity_status !== "ok").length,
    blank_serial: machines.filter(r => !r.serial_present).length, repeated_identity_groups: repeated.length,
    nonblank_serial_placeholders: machines.filter(r => r.serial_evidence === "placeholder").length,
    repeated_groups_with_recorded_serial: machines.filter(r => r.serial_evidence === "recorded"
      && r.repeated_identity_ids.length > 1 && r.repeated_identity_ids[0] === r.machine_no).length,
    repeated_identity_records: repeated.reduce((n, ids) => n + ids.length, 0),
    records_sharing_key_across_spellings: machines.filter(r => r.model_spellings > 1).length,
    found_nonempty_cache_label_mismatches: machines.filter(r => r.model_bom_found && r.cache_label_match === "labels differ").length,
    exact_diagram_matches: machines.filter(r => r.diagram_digest).length,
    history_by_origin: tally(history.map(h => h.origin)), history_by_edge: tally(history.map(h => h.edge_match)),
    ge_records: geMachines.length, ge_nonblank_serials: geMachines.filter(r => r.serial_present).length,
    ge_distinct_literal_nonblank_serials: new Set(geMachines.filter(r => r.serial_present).map(r => r.serial)).size,
    ge_comparison: tally(comparison.map(c => c.outcome)), ge_positions: positions.length,
    ge_positions_without_cache_counterpart: positions.filter(p => !p.catalog_in_cache && !p.replacement_in_cache).length,
    ge_supplier_rows: supplierRows.length,
    ge_position_supplier_agreement: tally(positions.map(p => p.supplier_agreement)),
    ge_supplier_callouts_outside_oem: supplierOnly.map(r => `${r.assembly} #${r.callout} ${r.mpn}`),
    ge_cache_keys_not_on_live_supplier: [...candidateKeys].filter(k => !supplierKeys.has(k)).sort(),
    ge_live_supplier_keys_not_in_cache: [...supplierKeys].filter(k => !candidateKeys.has(k)).sort()
  };
  // Each role is its own record with its own source; null stays null. Only the observation is about one machine.
  const maytag = primary ? callout10.numbers.map(n => ({ machine_no: primary.machine_no, model: primary.model_raw,
    serial: primary.serial, assembly: callout10.section, callout: callout10.callout, role: n.role, mpn: n.mpn,
    d1: canonicalizeMpn(n.mpn), source: n.source, evidence: n.evidence,
    scope: n.role === "observed" ? `machine ${primary.machine_no}` : `model ${primary.model_raw}`,
    factory_identity: "unresolved" })) : [];
  return { summary, machines, geMachines, comparison, positions, maytag, history };
}
