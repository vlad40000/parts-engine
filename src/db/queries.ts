import { and, eq, inArray, sql } from "drizzle-orm";
import { canonicalizeMpn, wpPrefixTarget } from "@/src/lib/mpn";
import { classifyFamily, libraryAppliance, PREFILTER_SKIP_FAMILIES, ALWAYS_SCRAP_FAMILIES, type PartFamily } from "@/src/lib/part-family";
import { resolveRemoval, SEED_BASELINES, type Baseline } from "@/src/lib/removal";
import { qualify, type EconomicsSettings, type Qualification } from "@/src/lib/economics";
import type { FleetRow } from "@/src/lib/fleet-import";
import { harvestCandidates, type MachineMatchRow } from "@/src/lib/harvest-candidates";
import type { MarketRow } from "@/src/lib/market-import";
import type { SaleRow } from "@/src/lib/sales-import";
import type { ChainResult } from "@/src/sources/chain";
import { bandsFor, DEFAULT_AGE_BANDS } from "@/src/lib/serial-decoder";
import * as t from "./schema";
import type { Db } from "./types";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export type AppSettings = EconomicsSettings & {
  /** Whole-machine acquisition overhead; not used in harvested-part qualification. */
  machineOverhead: number;
  batchSize: number;
  marketStaleDays: number;
  donorAvailabilities: string[];
};

const optionalNumber = (v: string | null) => (v == null ? null : Number(v));
const optionalNumeric = (v: number | null) => (v == null ? null : v.toFixed(2));

/** Both owner-set thresholds are entered; until then qualification is SET_RULE. */
export const rulesSet = (s: EconomicsSettings) => s.minimumSellThroughPct != null && s.minimumProfitMarginPct != null;

export async function getSettings(db: Db): Promise<AppSettings> {
  let [row] = await db.select().from(t.settings).where(eq(t.settings.id, 1));
  if (!row) {
    await db.insert(t.settings).values({ id: 1 }).onConflictDoNothing();
    [row] = await db.select().from(t.settings).where(eq(t.settings.id, 1));
  }
  // Legacy prototype columns (fee_pct, min_profit, harvest_cushion, ...) are deliberately not read.
  return {
    finalValueFeePct: Number(row.finalValueFeePct),
    promotedListingPct: Number(row.promotedListingPct),
    marketplaceTaxPct: Number(row.marketplaceTaxPct),
    perOrderFee: Number(row.perOrderFee),
    defaultShipLabel: Number(row.defaultShipLabel),
    packShipLabor: Number(row.packShipLabor),
    laborRateHr: Number(row.laborRateHr),
    ordinarySold90Minimum: row.ordinarySold90Minimum,
    minimumSellThroughPct: optionalNumber(row.minimumSellThroughPct),
    minimumProfitMarginPct: optionalNumber(row.minimumProfitMarginPct),
    harvestOverhead: {
      Refrigerator: Number(row.overheadRefrigerator),
      Washer: Number(row.overheadWasher),
      Range: Number(row.overheadRange),
      Dryer: Number(row.overheadDryer),
      Dishwasher: Number(row.overheadDishwasher),
      fallback: Number(row.overheadFallback)
    },
    machineOverhead: Number(row.machineOverhead),
    batchSize: row.batchSize,
    marketStaleDays: row.marketStaleDays,
    donorAvailabilities: row.donorAvailabilities
  };
}

export async function saveSettings(db: Db, s: AppSettings): Promise<void> {
  const values = {
    id: 1,
    finalValueFeePct: s.finalValueFeePct.toFixed(2),
    promotedListingPct: s.promotedListingPct.toFixed(2),
    marketplaceTaxPct: s.marketplaceTaxPct.toFixed(2),
    perOrderFee: s.perOrderFee.toFixed(2),
    defaultShipLabel: s.defaultShipLabel.toFixed(2),
    packShipLabor: s.packShipLabor.toFixed(2),
    laborRateHr: s.laborRateHr.toFixed(2),
    ordinarySold90Minimum: s.ordinarySold90Minimum,
    minimumSellThroughPct: optionalNumeric(s.minimumSellThroughPct),
    minimumProfitMarginPct: optionalNumeric(s.minimumProfitMarginPct),
    overheadRefrigerator: s.harvestOverhead.Refrigerator.toFixed(2),
    overheadWasher: s.harvestOverhead.Washer.toFixed(2),
    overheadRange: s.harvestOverhead.Range.toFixed(2),
    overheadDryer: s.harvestOverhead.Dryer.toFixed(2),
    overheadDishwasher: s.harvestOverhead.Dishwasher.toFixed(2),
    overheadFallback: s.harvestOverhead.fallback.toFixed(2),
    machineOverhead: s.machineOverhead.toFixed(2),
    batchSize: s.batchSize,
    marketStaleDays: s.marketStaleDays,
    donorAvailabilities: s.donorAvailabilities,
    updatedAt: new Date()
  };
  await db.insert(t.settings).values(values).onConflictDoUpdate({ target: t.settings.id, set: values });
}

export async function getBaselines(db: Db): Promise<Baseline[]> {
  const rows = await db.select().from(t.removalBaselines);
  if (!rows.length) {
    await db.insert(t.removalBaselines).values(SEED_BASELINES.map((b) => ({ ...b, minutes: String(b.minutes) }))).onConflictDoNothing();
    return SEED_BASELINES;
  }
  return rows.map((r) => ({ appliance: r.appliance, component: r.component, minutes: Number(r.minutes) }));
}

export async function upsertBaseline(db: Db, b: Baseline): Promise<void> {
  await db.insert(t.removalBaselines).values({ ...b, minutes: String(b.minutes) })
    .onConflictDoUpdate({ target: [t.removalBaselines.appliance, t.removalBaselines.component], set: { minutes: String(b.minutes) } });
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------
function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function upsertFleet(db: Db, rows: FleetRow[]): Promise<number> {
  for (const part of chunks(rows, 400)) {
    const values = part.map((r) => ({ ...r, source: "import", updatedAt: new Date() }));
    await db.insert(t.fleetMachines).values(values).onConflictDoUpdate({
      target: t.fleetMachines.machineNo,
      set: {
        availability: sql`excluded.availability`,
        applianceType: sql`excluded.appliance_type`,
        configuration: sql`excluded.configuration`,
        brand: sql`excluded.brand`,
        brandKey: sql`excluded.brand_key`,
        modelRaw: sql`excluded.model_raw`,
        modelKey: sql`excluded.model_key`,
        serial: sql`excluded.serial`,
        color: sql`excluded.color`,
        condition: sql`excluded.condition`,
        location: sql`excluded.location`,
        diagnosis: sql`excluded.diagnosis`,
        notes: sql`excluded.notes`,
        listPrice: sql`excluded.list_price`,
        acquiredAt: sql`excluded.acquired_at`,
        identityStatus: sql`excluded.identity_status`,
        suspectFamilies: sql`excluded.suspect_families`,
        ageFamily: sql`excluded.age_family`,
        ageCandidateYears: sql`excluded.age_candidate_years`,
        ageMonth: sql`excluded.age_month`,
        ageWeek: sql`excluded.age_week`,
        ageConfidence: sql`excluded.age_confidence`,
        ageNote: sql`excluded.age_note`,
        updatedAt: sql`now()`
      }
    });
  }
  return rows.length;
}

export type FleetFilter = { band?: string; type?: string; brand?: string; availability?: string; q?: string };

function fleetWhere(f: FleetFilter) {
  const parts = [sql`true`];
  if (f.availability) parts.push(sql`f.availability = ${f.availability}`);
  if (f.type) parts.push(sql`f.appliance_type = ${f.type}`);
  if (f.brand) parts.push(sql`f.brand_key = ${f.brand}`);
  if (f.q) parts.push(sql`(f.machine_no ilike ${"%" + f.q + "%"} or f.model_raw ilike ${"%" + f.q + "%"} or f.serial ilike ${"%" + f.q + "%"})`);
  if (f.band) {
    const band = DEFAULT_AGE_BANDS.find((b) => b.key === f.band);
    if (band) parts.push(sql`exists (select 1 from unnest(f.age_candidate_years) y where y between ${band.start} and ${band.end})`);
    else if (f.band === "unknown") parts.push(sql`cardinality(f.age_candidate_years) = 0`);
  }
  return sql.join(parts, sql` and `);
}

type Rows<T> = { rows: T[] };
async function q<T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as Rows<T>;
  return res.rows;
}

/** Statuses that mean the machine is no longer on the lot. */
export const OFF_LOT = ["SOLD", "SCRAPED", "SCRAPPED"];

export async function fleetSummary(db: Db) {
  const onLot = sql.raw(`f.availability <> all(${pgTextArray(OFF_LOT)})`);
  const [totals] = await q<{ machines: number; models: number; needs_nameplate: number; with_bom: number; models_with_bom: number }>(db, sql`
    select count(*)::int machines,
      count(distinct (f.brand_key, f.model_key)) filter (where f.identity_status = 'ok')::int models,
      count(*) filter (where f.identity_status <> 'ok')::int needs_nameplate,
      count(*) filter (where c.status = 'found')::int with_bom,
      count(distinct (f.brand_key, f.model_key)) filter (where c.status = 'found')::int models_with_bom
    from fleet_machines f
    left join model_bom_cache c on c.brand_key = f.brand_key and c.model_key = f.model_key
    where ${onLot}`);
  const [{ off_lot }] = await q<{ off_lot: number }>(db, sql`select count(*)::int off_lot from fleet_machines f where not (${onLot})`);
  const availability = await q<{ availability: string; n: number }>(db, sql`
    select availability, count(*)::int n from fleet_machines group by 1 order by 2 desc`);
  const types = await q<{ appliance_type: string; years: number[] }>(db, sql`
    select appliance_type, age_candidate_years years from fleet_machines f where ${onLot}`);
  const bandKeys = [...DEFAULT_AGE_BANDS.map((b) => b.key), "unknown"];
  const matrix = new Map<string, Record<string, number>>();
  for (const r of types) {
    const row = matrix.get(r.appliance_type) ?? Object.fromEntries(bandKeys.map((k) => [k, 0]));
    const bands = bandsFor(r.years ?? []);
    if (!bands.length) row.unknown += 1;
    for (const b of bands) row[b] += 1;
    row.total = (row.total ?? 0) + 1;
    matrix.set(r.appliance_type, row);
  }
  const bandMatrix = [...matrix.entries()].map(([type, counts]) => ({ type, counts })).sort((a, b) => (b.counts.total ?? 0) - (a.counts.total ?? 0));
  const [market] = await q<{ mpns: number; researched: number }>(db, sql`
    select (select count(*)::int from mpn_master) mpns, (select count(*)::int from market_facts) researched`);
  return { totals, offLot: off_lot, availability, bandMatrix, bandKeys, market };
}

export async function listFleet(db: Db, f: FleetFilter, limit = 100, offset = 0) {
  const rows = await q<{
    machine_no: string; availability: string; appliance_type: string; brand: string; model_raw: string; serial: string;
    identity_status: string; age_candidate_years: number[]; age_confidence: string; suspect_families: string[]; bom_status: string | null;
  }>(db, sql`
    select f.machine_no, f.availability, f.appliance_type, f.brand, f.model_raw, f.serial, f.identity_status,
      f.age_candidate_years, f.age_confidence, f.suspect_families, c.status bom_status
    from fleet_machines f
    left join model_bom_cache c on c.brand_key = f.brand_key and c.model_key = f.model_key
    where ${fleetWhere(f)}
    order by case when f.machine_no ~ '^[0-9]+$' then lpad(f.machine_no, 12, '0') else f.machine_no end
    limit ${limit} offset ${offset}`);
  const [{ n }] = await q<{ n: number }>(db, sql`select count(*)::int n from fleet_machines f where ${fleetWhere(f)}`);
  return { rows, total: n };
}

export async function fleetFacets(db: Db) {
  const types = await q<{ v: string }>(db, sql`select distinct appliance_type v from fleet_machines where appliance_type <> '' order by 1`);
  const brands = await q<{ v: string }>(db, sql`select brand_key v from fleet_machines where brand_key <> '' group by 1 order by count(*) desc limit 60`);
  const availability = await q<{ v: string }>(db, sql`select distinct availability v from fleet_machines order by 1`);
  return { types: types.map((r) => r.v), brands: brands.map((r) => r.v), availability: availability.map((r) => r.v) };
}

// ---------------------------------------------------------------------------
// BOM queue + persistence
// ---------------------------------------------------------------------------
export type ModelCandidate = {
  brand_key: string; model_key: string; brand: string; model: string; machines: number; types: string; bom_status: string | null;
};

/** Unique models still needing a parts list, most machines first (best BOM reuse). */
export async function modelsNeedingBom(db: Db, f: FleetFilter, donorSet: string[], limit = 200): Promise<ModelCandidate[]> {
  return q<ModelCandidate>(db, sql`
    select f.brand_key, f.model_key, min(f.brand) brand, min(f.model_raw) model, count(*)::int machines,
      string_agg(distinct f.appliance_type, ', ') types, min(c.status) bom_status
    from fleet_machines f
    left join model_bom_cache c on c.brand_key = f.brand_key and c.model_key = f.model_key
    where f.identity_status = 'ok' and f.model_key <> ''
      and f.availability = any(${sql.raw(pgTextArray(donorSet))})
      and (c.status is null or c.status = 'error')
      and ${fleetWhere(f)}
    group by f.brand_key, f.model_key
    order by count(*) desc, f.brand_key, f.model_key
    limit ${limit}`);
}

function pgTextArray(values: string[]): string {
  return `array[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",")}]::text[]`;
}

export async function saveModelBom(
  db: Db,
  input: { brandKey: string; modelKey: string; brandDisplay: string; modelDisplay: string; result: ChainResult }
): Promise<{ rows: number; newMpns: number }> {
  const { result } = input;
  const winner = result.winner;
  const warnings = result.attempts.flatMap((a) => a.warnings.map((w) => `${a.supplier}: ${w}`));
  const cache = {
    brandKey: input.brandKey,
    modelKey: input.modelKey,
    brandDisplay: input.brandDisplay,
    modelDisplay: input.modelDisplay,
    status: result.status,
    source: winner?.supplier ?? null,
    sourceUrl: winner?.sourceUrl ?? null,
    rowCount: winner?.rows.length ?? 0,
    droppedRows: winner?.droppedRows ?? 0,
    attempts: result.attempts,
    warnings,
    fetchedAt: new Date()
  };
  await db.insert(t.modelBomCache).values(cache).onConflictDoUpdate({
    target: [t.modelBomCache.brandKey, t.modelBomCache.modelKey],
    set: { ...cache, attempts: sql`excluded.attempts`, warnings: sql`excluded.warnings` }
  });
  if (!winner) return { rows: 0, newMpns: 0 };

  // Resolve WP prefix aliases before writing (D1: aliases, not normalization).
  const aliasRows: Array<typeof t.mpnAlias.$inferInsert> = [];
  const resolved = winner.rows.map((r) => {
    const target = wpPrefixTarget(r.mpnCanonical);
    if (target) {
      aliasRows.push({ aliasCanonical: r.mpnCanonical, mpnCanonical: target, kind: "wp_prefix", source: winner.supplier });
      return { ...r, mpnCanonical: target };
    }
    return r;
  });
  const existingAliases = resolved.length
    ? await db.select().from(t.mpnAlias).where(inArray(t.mpnAlias.aliasCanonical, resolved.map((r) => r.mpnCanonical)))
    : [];
  const aliasMap = new Map(existingAliases.map((a) => [a.aliasCanonical, a.mpnCanonical]));
  const byMpn = new Map<string, (typeof resolved)[number]>();
  for (const r of resolved) {
    const canonical = aliasMap.get(r.mpnCanonical) ?? r.mpnCanonical;
    if (!byMpn.has(canonical)) byMpn.set(canonical, { ...r, mpnCanonical: canonical });
  }
  const rows = [...byMpn.values()];

  if (aliasRows.length) await db.insert(t.mpnAlias).values(aliasRows).onConflictDoNothing();

  await db.delete(t.modelPartEdges).where(and(eq(t.modelPartEdges.brandKey, input.brandKey), eq(t.modelPartEdges.modelKey, input.modelKey)));
  for (const part of chunks(rows, 300)) {
    await db.insert(t.modelPartEdges).values(part.map((r) => ({
      brandKey: input.brandKey,
      modelKey: input.modelKey,
      mpnCanonical: r.mpnCanonical,
      mpnDisplay: r.mpnDisplay,
      description: r.description,
      diagramId: r.diagramId,
      supplierPartId: r.supplierPartId,
      newPrice: r.newPrice == null ? null : r.newPrice.toFixed(2),
      nla: r.nla,
      source: winner.supplier
    }))).onConflictDoNothing();
  }

  const before = await db.select({ m: t.mpnMaster.mpnCanonical }).from(t.mpnMaster).where(inArray(t.mpnMaster.mpnCanonical, rows.map((r) => r.mpnCanonical)));
  for (const part of chunks(rows, 300)) {
    await db.insert(t.mpnMaster).values(part.map((r) => ({
      mpnCanonical: r.mpnCanonical,
      mpnDisplay: r.mpnDisplay,
      description: r.description,
      partFamily: classifyFamily(r.description),
      newPriceMin: r.newPrice == null ? null : r.newPrice.toFixed(2)
    }))).onConflictDoUpdate({
      target: t.mpnMaster.mpnCanonical,
      set: {
        description: sql`case when mpn_master.description = '' then excluded.description else mpn_master.description end`,
        partFamily: sql`case when mpn_master.description = '' then excluded.part_family else mpn_master.part_family end`,
        newPriceMin: sql`least(mpn_master.new_price_min, excluded.new_price_min)`,
        updatedAt: sql`now()`
      }
    });
  }
  return { rows: rows.length, newMpns: rows.length - before.length };
}

// ---------------------------------------------------------------------------
// MPN index: supply depth + market + v7 qualification
// ---------------------------------------------------------------------------
export type MpnRow = {
  mpn_canonical: string; mpn_display: string; description: string; part_family: PartFamily; new_price_min: string | null;
  removal_min: string | null; removal_source: string | null; force_research: boolean;
  packaging_cost: string | null; strategic_exception_approved: boolean;
  models: number; donors: number; appliance_mode: string | null;
  sold_90: number | null; avg_price: string | null; avg_ship: string | null; sell_through_pct: string | null; sell_through_source: "manual" | "research" | null; active_qty: number | null;
  free_shipping: boolean | null; ship_cost: string | null; qty_on_hand: number | null; researched_at: string | null; market_source: string | null;
};

export type MpnEvaluated = MpnRow & {
  removal: { minutes: number | null; source: string | null; component: string | null };
  market: "missing" | "current" | "stale";
  qualification: Qualification | null;
  prefilter: string | null;
};

const MPN_SELECT = (donorSet: string[]) => sql`
  with supply as (
    select e.mpn_canonical,
      count(distinct (e.brand_key, e.model_key))::int models,
      count(distinct f.machine_no) filter (
        where f.identity_status = 'ok' and f.availability = any(${sql.raw(pgTextArray(donorSet))})
          and not exists (select 1 from machine_part_state s where s.machine_no = f.machine_no and s.mpn_canonical = e.mpn_canonical)
      )::int donors,
      mode() within group (order by f.appliance_type) appliance_mode
    from model_part_edges e
    left join fleet_machines f on f.brand_key = e.brand_key and f.model_key = e.model_key
    group by e.mpn_canonical
  )
  select m.mpn_canonical, m.mpn_display, m.description, m.part_family, m.new_price_min, m.removal_min, m.removal_source, m.force_research,
    m.packaging_cost, m.strategic_exception_approved,
    coalesce(s.models, 0) models, coalesce(s.donors, 0) donors, s.appliance_mode,
    k.sold_90, k.avg_price, k.avg_ship, k.sell_through_pct, k.sell_through_source, k.active_qty, k.free_shipping, k.ship_cost, k.qty_on_hand,
    k.researched_at::text researched_at, k.source market_source
  from mpn_master m
  left join supply s on s.mpn_canonical = m.mpn_canonical
  left join market_facts k on k.mpn_canonical = m.mpn_canonical`;

export function evaluateMpn(row: MpnRow, s: AppSettings, baselines: Baseline[], now = new Date()): MpnEvaluated {
  const appliance = libraryAppliance(row.appliance_mode);
  const removal = resolveRemoval({
    mpnCanonical: row.mpn_canonical,
    appliance,
    description: row.description,
    storedMinutes: row.removal_min == null ? null : Number(row.removal_min),
    storedSource: row.removal_source,
    baselines
  });
  const hasMarket = row.sold_90 != null || row.avg_price != null;
  const ageDays = row.researched_at ? (now.getTime() - new Date(row.researched_at).getTime()) / 86_400_000 : Infinity;
  const market: MpnEvaluated["market"] = !hasMarket ? "missing" : ageDays > s.marketStaleDays ? "stale" : "current";

  // Family prefilters only. There is no general minimum part price (v7); the floor is per part.
  let prefilter: string | null = null;
  if (ALWAYS_SCRAP_FAMILIES.includes(row.part_family)) prefilter = "Compressor: always scrap.";
  else if (!row.force_research && PREFILTER_SKIP_FAMILIES.includes(row.part_family)) prefilter = `Family "${row.part_family}" is not researched by default.`;

  let qualification: Qualification | null = null;
  if (hasMarket && !ALWAYS_SCRAP_FAMILIES.includes(row.part_family)) {
    qualification = qualify({
      P: row.avg_price == null ? null : Number(row.avg_price),
      B: row.avg_ship == null ? null : Number(row.avg_ship),
      freeShipping: Boolean(row.free_shipping),
      S: row.ship_cost == null ? null : Number(row.ship_cost),
      removalMin: removal.minutes,
      packagingCost: row.packaging_cost == null ? null : Number(row.packaging_cost),
      appliance,
      sold90: row.sold_90,
      // Exact-MPN sell-through only; never sold_90 / active_qty.
      sellThroughPct: row.sell_through_pct == null ? null : Number(row.sell_through_pct),
      strategicExceptionApproved: row.strategic_exception_approved
    }, s);
  }
  return { ...row, removal, market, qualification, prefilter };
}

export type MpnFilter = {
  view?: "all" | "qualified" | "queue" | "not_qualified" | "needs_data" | "set_rule" | "prefiltered";
  family?: string;
  q?: string;
};

export async function mpnIndex(db: Db, f: MpnFilter, limit = 200, offset = 0) {
  const s = await getSettings(db);
  const baselines = await getBaselines(db);
  const where = [sql`true`];
  if (f.family) where.push(sql`part_family = ${f.family}`);
  if (f.q) where.push(sql`(mpn_canonical ilike ${"%" + f.q.toUpperCase().replace(/[^A-Z0-9]/g, "") + "%"} or description ilike ${"%" + f.q + "%"})`);
  if (f.view === "qualified" || f.view === "not_qualified" || f.view === "needs_data" || f.view === "set_rule") {
    where.push(sql`(sold_90 is not null or avg_price is not null)`);
  }
  const all = await q<MpnRow>(db, sql`select * from (${MPN_SELECT(s.donorAvailabilities)}) x where ${sql.join(where, sql` and `)} order by donors desc, mpn_canonical`);
  let rows = all.map((r) => evaluateMpn(r, s, baselines));
  const result = (r: MpnEvaluated) => r.qualification?.result;
  // Ordering only: the workbook's modeled value / slot-day.
  if (f.view === "qualified") rows = rows.filter((r) => result(r) === "QUALIFIED").sort((a, b) => valueOf(b) - valueOf(a));
  if (f.view === "not_qualified") rows = rows.filter((r) => result(r) === "NOT_QUALIFIED");
  if (f.view === "needs_data") rows = rows.filter((r) => result(r) === "NEEDS_DATA");
  if (f.view === "set_rule") rows = rows.filter((r) => result(r) === "SET_RULE");
  if (f.view === "queue") rows = rows.filter((r) => r.market !== "current" && !r.prefilter && r.donors > 0);
  if (f.view === "prefiltered") rows = rows.filter((r) => r.prefilter && r.market === "missing");
  const counts = {
    all: all.length,
    qualified: 0, not_qualified: 0, needs_data: 0, set_rule: 0, queue: 0, prefiltered: 0
  };
  if (!f.view || f.view === "all") {
    for (const r of rows) {
      if (result(r) === "QUALIFIED") counts.qualified += 1;
      else if (result(r) === "NOT_QUALIFIED") counts.not_qualified += 1;
      else if (result(r) === "NEEDS_DATA") counts.needs_data += 1;
      else if (result(r) === "SET_RULE") counts.set_rule += 1;
      if (r.market !== "current" && !r.prefilter && r.donors > 0) counts.queue += 1;
      if (r.prefilter && r.market === "missing") counts.prefiltered += 1;
    }
  }
  return { rows: rows.slice(offset, offset + limit), total: rows.length, counts, settings: s, rulesSet: rulesSet(s) };
}

const valueOf = (r: MpnEvaluated) => r.qualification?.modeledValueSlotDay ?? -Infinity;

export async function mpnDetail(db: Db, mpnRaw: string) {
  const s = await getSettings(db);
  const baselines = await getBaselines(db);
  let canonical = canonicalizeMpn(mpnRaw);
  const [alias] = await db.select().from(t.mpnAlias).where(eq(t.mpnAlias.aliasCanonical, canonical));
  if (alias) canonical = alias.mpnCanonical;
  const [row] = await q<MpnRow>(db, sql`select * from (${MPN_SELECT(s.donorAvailabilities)}) x where mpn_canonical = ${canonical}`);
  if (!row) return null;
  const evaluated = evaluateMpn(row, s, baselines);
  const aliases = await db.select().from(t.mpnAlias).where(eq(t.mpnAlias.mpnCanonical, canonical));
  const machines = await q<MachineMatchRow>(db, sql`
    select f.machine_no, f.availability, f.appliance_type, f.brand, f.brand_key, f.model_raw, f.model_key, e.diagram_id,
      f.age_candidate_years, f.suspect_families, f.identity_status, s.state
    from model_part_edges e
    join fleet_machines f on f.brand_key = e.brand_key and f.model_key = e.model_key
    left join machine_part_state s on s.machine_no = f.machine_no and s.mpn_canonical = e.mpn_canonical
    where e.mpn_canonical = ${canonical}
    order by f.availability, f.machine_no`);
  const models = await q<{ brand_key: string; model_key: string; description: string; new_price: string | null; source: string }>(db, sql`
    select brand_key, model_key, description, new_price, source from model_part_edges where mpn_canonical = ${canonical} order by 1, 2`);
  const roadrunner = (await roadrunnerPerformance(db, [canonical])).get(canonical) ?? null;
  // Physical facts only; economic qualification never decides who is a candidate.
  const harvest = harvestCandidates(machines, row.part_family, s.donorAvailabilities);
  return { mpn: evaluated, aliases, machines, harvest, models, roadrunner, settings: s };
}

// ---------------------------------------------------------------------------
// Roadrunner sales history ("what has actually sold for us"), kept apart from market_facts
// ---------------------------------------------------------------------------
/**
 * Aggregate of recorded Roadrunner sale events for one D1 MPN. An MPN with no recorded
 * events has no aggregate at all (null), never a row of zeros.
 */
export type RoadrunnerPerformance = {
  mpnCanonical: string;
  unitsSold: number;
  saleEvents: number;
  /** Per-unit price, weighted by quantity, over events whose price is known. */
  avgItemPrice: number | null;
  pricedUnits: number;
  lastSoldAt: string;
  /** Mean over events whose days-to-sell is known (supplied or derived from listed_at). */
  avgDaysToSell: number | null;
  daysToSellEvents: number;
  sources: string[];
};

export async function roadrunnerPerformance(db: Db, mpns: string[]): Promise<Map<string, RoadrunnerPerformance>> {
  const keys = [...new Set(mpns.filter(Boolean))];
  if (!keys.length) return new Map();
  const rows = await q<{
    mpn_canonical: string; units_sold: number; sale_events: number; avg_item_price: string | null; priced_units: number;
    last_sold_at: string; avg_days_to_sell: string | null; days_to_sell_events: number; sources: string[];
  }>(db, sql`
    select mpn_canonical,
      sum(quantity)::int units_sold,
      count(*)::int sale_events,
      round(sum(item_price * quantity) filter (where item_price is not null)
        / nullif(sum(quantity) filter (where item_price is not null), 0), 2) avg_item_price,
      coalesce(sum(quantity) filter (where item_price is not null), 0)::int priced_units,
      max(sold_at)::text last_sold_at,
      round(avg(days_to_sell), 1) avg_days_to_sell,
      count(days_to_sell)::int days_to_sell_events,
      array_agg(distinct source order by source) sources
    from roadrunner_sale_events
    where mpn_canonical = any(${sql.raw(pgTextArray(keys))})
    group by mpn_canonical`);
  return new Map(rows.map((r) => [r.mpn_canonical, {
    mpnCanonical: r.mpn_canonical,
    unitsSold: r.units_sold,
    saleEvents: r.sale_events,
    avgItemPrice: r.avg_item_price == null ? null : Number(r.avg_item_price),
    pricedUnits: r.priced_units,
    lastSoldAt: r.last_sold_at,
    avgDaysToSell: r.avg_days_to_sell == null ? null : Number(r.avg_days_to_sell),
    daysToSellEvents: r.days_to_sell_events,
    sources: r.sources
  }]));
}

/** CSV import source. Kept constant so re-importing a file under another name stays idempotent. */
export const ROADRUNNER_CSV_SOURCE = "roadrunner_csv";

export async function upsertSaleEvents(
  db: Db,
  rows: SaleRow[],
  opts: { source?: string } = {}
): Promise<{ inserted: number; updated: number; notInAnyPartsList: number }> {
  const source = opts.source ?? ROADRUNNER_CSV_SOURCE;
  let inserted = 0;
  for (const part of chunks(rows, 300)) {
    const res = await db.insert(t.roadrunnerSaleEvents).values(part.map((r) => ({
      source,
      sourceEventId: r.sourceEventId,
      mpnCanonical: r.mpnCanonical,
      mpnDisplay: r.mpnDisplay,
      soldAt: r.soldAt,
      quantity: r.quantity,
      itemPrice: r.itemPrice == null ? null : r.itemPrice.toFixed(2),
      listedAt: r.listedAt,
      daysToSell: r.daysToSell,
      daysToSellSource: r.daysToSellSource,
      updatedAt: new Date()
    }))).onConflictDoUpdate({
      target: [t.roadrunnerSaleEvents.source, t.roadrunnerSaleEvents.sourceEventId, t.roadrunnerSaleEvents.mpnCanonical],
      set: {
        mpnDisplay: sql`excluded.mpn_display`, soldAt: sql`excluded.sold_at`, quantity: sql`excluded.quantity`,
        itemPrice: sql`excluded.item_price`, listedAt: sql`excluded.listed_at`, daysToSell: sql`excluded.days_to_sell`,
        daysToSellSource: sql`excluded.days_to_sell_source`, updatedAt: sql`now()`
      }
    }).returning({ inserted: sql<boolean>`(xmax = 0)` });
    inserted += res.filter((x) => x.inserted).length;
  }
  const mpns = [...new Set(rows.map((r) => r.mpnCanonical))];
  const onLists = mpns.length
    ? await q<{ m: string }>(db, sql`select distinct mpn_canonical m from model_part_edges where mpn_canonical = any(${sql.raw(pgTextArray(mpns))})`)
    : [];
  return { inserted, updated: rows.length - inserted, notInAnyPartsList: mpns.length - onLists.length };
}

export async function getMarketFacts(db: Db, canonical: string) {
  const [row] = await db.select().from(t.marketFacts).where(eq(t.marketFacts.mpnCanonical, canonical));
  return row ?? null;
}

export async function upsertMarketFacts(db: Db, rows: MarketRow[], source: string): Promise<{ saved: number; unknown: number }> {
  let unknown = 0;
  const aliases = rows.length
    ? await db.select().from(t.mpnAlias).where(inArray(t.mpnAlias.aliasCanonical, rows.map((r) => r.mpnCanonical)))
    : [];
  const aliasMap = new Map(aliases.map((a) => [a.aliasCanonical, a.mpnCanonical]));
  const known = new Set(
    (rows.length ? await db.select({ m: t.mpnMaster.mpnCanonical }).from(t.mpnMaster) : []).map((r) => r.m)
  );
  for (const part of chunks(rows, 300)) {
    const values = part.map((r) => {
      const canonical = aliasMap.get(r.mpnCanonical) ?? r.mpnCanonical;
      if (!known.has(canonical)) unknown += 1;
      return {
        mpnCanonical: canonical,
        sold90: r.sold90,
        avgPrice: r.avgPrice == null ? null : r.avgPrice.toFixed(2),
        avgShip: r.avgShip == null ? null : r.avgShip.toFixed(2),
        sellThroughPct: r.sellThroughPct == null ? null : r.sellThroughPct.toFixed(2),
        sellThroughSource: r.sellThroughPct == null ? null : r.sellThroughSource ?? "research",
        activeQty: r.activeQty,
        freeShipping: r.freeShipping,
        shipCost: r.shipCost == null ? null : r.shipCost.toFixed(2),
        qtyOnHand: r.qtyOnHand == null ? null : Math.round(r.qtyOnHand),
        researchedAt: r.researchedAt ?? new Date().toISOString().slice(0, 10),
        source,
        updatedAt: new Date()
      };
    });
    await db.insert(t.marketFacts).values(values).onConflictDoUpdate({
      target: t.marketFacts.mpnCanonical,
      set: {
        sold90: sql`excluded.sold_90`, avgPrice: sql`excluded.avg_price`, avgShip: sql`excluded.avg_ship`,
        sellThroughPct: sql`excluded.sell_through_pct`, sellThroughSource: sql`excluded.sell_through_source`, activeQty: sql`excluded.active_qty`,
        freeShipping: sql`excluded.free_shipping`, shipCost: sql`excluded.ship_cost`,
        qtyOnHand: sql`coalesce(excluded.qty_on_hand, market_facts.qty_on_hand)`,
        researchedAt: sql`excluded.researched_at`, source: sql`excluded.source`, updatedAt: sql`now()`
      }
    });
  }
  // Market rows for MPNs not yet in any parts list still need a master row to show up.
  const missing = rows.filter((r) => !known.has(aliasMap.get(r.mpnCanonical) ?? r.mpnCanonical));
  for (const part of chunks(missing, 300)) {
    await db.insert(t.mpnMaster).values(part.map((r) => ({
      mpnCanonical: aliasMap.get(r.mpnCanonical) ?? r.mpnCanonical,
      mpnDisplay: r.mpnDisplay,
      description: r.description ?? "",
      partFamily: classifyFamily(r.description ?? "")
    }))).onConflictDoNothing();
  }
  return { saved: rows.length, unknown };
}

/** Provider-owned 90-day SOLD facts from a live EbayDecisions refresh. Null means unknown. */
export type ProviderSoldPatch = {
  mpnCanonical: string;
  sold90: number | null;
  /**
   * True only when the provider's 90-day price basis is "sold". Otherwise avgPrice/avgShip are
   * null and are never written: existing confirmed price/shipping are kept, a new row stays null.
   */
  priceIsSold: boolean;
  avgPrice: number | null;
  avgShip: number | null;
  sellThroughPct: number | null;
  sellThroughSource: "research" | null;
  /** Calendar date of the provider's SOLD capture, never the active snapshot's. */
  researchedAt: string;
};
export type ProviderActivePatch = { mpnCanonical: string; activeQty: number | null };

/**
 * Focused upsert for live provider facts. Unlike upsertMarketFacts (file/manual imports),
 * it only ever sets provider-owned columns: free_shipping, ship_cost and qty_on_hand keep
 * their local values, and the active patch never touches sold facts or researched_at.
 * Callers validate the whole provider response before calling this.
 */
export async function patchProviderMarketFacts(
  db: Db,
  sold: ProviderSoldPatch[],
  active: ProviderActivePatch[],
  source: string
): Promise<void> {
  const money = (v: number | null) => (v == null ? null : v.toFixed(2));
  // Asking/unknown-basis prices must never reach PE-4 economics as sold prices, so those rows
  // update sold quantity, sell-through and SOLD freshness but leave avg_price/avg_ship alone.
  for (const priced of [true, false]) {
    const rows = sold.filter((r) => r.priceIsSold === priced);
    if (!rows.length) continue;
    await db.insert(t.marketFacts).values(rows.map((r) => ({
      mpnCanonical: r.mpnCanonical,
      sold90: r.sold90,
      avgPrice: priced ? money(r.avgPrice) : null,
      avgShip: priced ? money(r.avgShip) : null,
      sellThroughPct: money(r.sellThroughPct),
      sellThroughSource: r.sellThroughPct == null ? null : r.sellThroughSource,
      researchedAt: r.researchedAt,
      source,
      updatedAt: new Date()
    }))).onConflictDoUpdate({
      target: t.marketFacts.mpnCanonical,
      set: {
        sold90: sql`excluded.sold_90`,
        ...(priced ? { avgPrice: sql`excluded.avg_price`, avgShip: sql`excluded.avg_ship` } : {}),
        sellThroughPct: sql`excluded.sell_through_pct`, sellThroughSource: sql`excluded.sell_through_source`,
        researchedAt: sql`excluded.researched_at`, source: sql`excluded.source`, updatedAt: sql`now()`
      }
    });
  }
  if (active.length) {
    await db.insert(t.marketFacts).values(active.map((r) => ({
      mpnCanonical: r.mpnCanonical, activeQty: r.activeQty, source, updatedAt: new Date()
    }))).onConflictDoUpdate({
      target: t.marketFacts.mpnCanonical,
      set: { activeQty: sql`excluded.active_qty`, updatedAt: sql`now()` }
    });
  }
}

export async function updateMpnManual(db: Db, canonical: string, patch: {
  removalMin?: number | null; forceResearch?: boolean; description?: string;
  packagingCost?: number | null; strategicExceptionApproved?: boolean;
}) {
  const set: Partial<typeof t.mpnMaster.$inferInsert> = { updatedAt: new Date() };
  if (patch.removalMin !== undefined) {
    set.removalMin = patch.removalMin == null ? null : String(patch.removalMin);
    set.removalSource = patch.removalMin == null ? null : "manual";
  }
  if (patch.forceResearch !== undefined) set.forceResearch = patch.forceResearch;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.packagingCost !== undefined) set.packagingCost = optionalNumeric(patch.packagingCost);
  if (patch.strategicExceptionApproved !== undefined) set.strategicExceptionApproved = patch.strategicExceptionApproved;
  await db.update(t.mpnMaster).set(set).where(eq(t.mpnMaster.mpnCanonical, canonical));
}

export async function addAlias(db: Db, aliasRaw: string, targetRaw: string, kind: "supersedes" | "wp_prefix" | "variant") {
  const alias = canonicalizeMpn(aliasRaw);
  const target = canonicalizeMpn(targetRaw);
  if (!alias || !target || alias === target) throw new Error("Alias and target must be different MPNs.");
  await db.insert(t.mpnAlias).values({ aliasCanonical: alias, mpnCanonical: target, kind, source: "manual" })
    .onConflictDoUpdate({ target: t.mpnAlias.aliasCanonical, set: { mpnCanonical: target, kind } });
}

// ---------------------------------------------------------------------------
// Teardown queue (Station 3.5 PLAN)
// ---------------------------------------------------------------------------
export type PullLine = {
  mpn_canonical: string; mpn_display: string; description: string; diagram_id: string; family: string;
  removal_min: number | null; break_even: number | null; contribution: number; margin_pct: number | null;
  modeled_value_slot_day: number | null; suspect: boolean;
};
export type TeardownRow = {
  machine_no: string; brand: string; model_raw: string; appliance_type: string; availability: string;
  age_candidate_years: number[];
  /** Ordering key only: sum of modeled value / slot-day of qualified parts. Not a profit score. */
  order_value: number;
  lines: PullLine[]; suspect_lines: PullLine[];
};
export type TeardownResult = { status: "set_rule" | "ok"; rows: TeardownRow[]; qualified: number; settings: AppSettings };

/**
 * Only QUALIFIED MPNs enter the teardown layer, and only once both owner thresholds are set.
 * Every donor holding a qualified part is listed: no pull cap or stock target, and no
 * sold_90 / active_qty share. Machines are ordered by the workbook's modeled value / slot-day.
 * Parts matching the machine's failure symptom are listed as test first and not counted.
 */
export async function teardownQueue(db: Db, limit = 100): Promise<TeardownResult> {
  const s = await getSettings(db);
  if (!rulesSet(s)) return { status: "set_rule", rows: [], qualified: 0, settings: s };
  const { rows: qualifiedRows } = await mpnIndex(db, { view: "qualified" }, 100000);
  if (!qualifiedRows.length) return { status: "ok", rows: [], qualified: 0, settings: s };
  const byMpn = new Map(qualifiedRows.map((r) => [r.mpn_canonical, r]));
  const candidates = await q<{
    machine_no: string; brand: string; model_raw: string; appliance_type: string; availability: string;
    age_candidate_years: number[]; suspect_families: string[]; mpn_canonical: string; diagram_id: string; description: string;
  }>(db, sql`
    select f.machine_no, f.brand, f.model_raw, f.appliance_type, f.availability, f.age_candidate_years, f.suspect_families,
      e.mpn_canonical, e.diagram_id, e.description
    from model_part_edges e
    join fleet_machines f on f.brand_key = e.brand_key and f.model_key = e.model_key
    where e.mpn_canonical = any(${sql.raw(pgTextArray([...byMpn.keys()]))})
      and f.identity_status = 'ok' and f.availability = any(${sql.raw(pgTextArray(s.donorAvailabilities))})
      and not exists (select 1 from machine_part_state ps where ps.machine_no = f.machine_no and ps.mpn_canonical = e.mpn_canonical)`);

  const machines = new Map<string, TeardownRow>();
  for (const c of candidates) {
    const m = byMpn.get(c.mpn_canonical);
    if (!m || m.qualification?.result !== "QUALIFIED") continue;
    const econ = m.qualification.economics;
    const row = machines.get(c.machine_no) ?? {
      machine_no: c.machine_no, brand: c.brand, model_raw: c.model_raw, appliance_type: c.appliance_type,
      availability: c.availability, age_candidate_years: c.age_candidate_years, order_value: 0, lines: [], suspect_lines: []
    };
    const line: PullLine = {
      mpn_canonical: c.mpn_canonical, mpn_display: m.mpn_display, description: m.description || c.description, diagram_id: c.diagram_id,
      family: m.part_family, removal_min: m.removal.minutes, break_even: econ.breakEven, contribution: econ.contribution,
      margin_pct: econ.marginPct, modeled_value_slot_day: m.qualification.modeledValueSlotDay,
      suspect: (c.suspect_families ?? []).includes(m.part_family)
    };
    if (line.suspect) row.suspect_lines.push(line);
    else row.lines.push(line);
    machines.set(c.machine_no, row);
  }
  const lineValue = (l: PullLine) => l.modeled_value_slot_day ?? 0;
  const rows = [...machines.values()].filter((m) => m.lines.length > 0).map((m) => {
    m.lines.sort((a, b) => lineValue(b) - lineValue(a));
    m.order_value = Math.round(m.lines.reduce((n, l) => n + lineValue(l), 0) * 10000) / 10000;
    return m;
  });
  rows.sort((a, b) => b.order_value - a.order_value || a.machine_no.localeCompare(b.machine_no));
  return { status: "ok", rows: rows.slice(0, limit), qualified: qualifiedRows.length, settings: s };
}

// ---------------------------------------------------------------------------
// Machine detail + part state
// ---------------------------------------------------------------------------
export async function machineDetail(db: Db, machineNo: string) {
  const [machine] = await db.select().from(t.fleetMachines).where(eq(t.fleetMachines.machineNo, machineNo));
  if (!machine) return null;
  const [bom] = await db.select().from(t.modelBomCache)
    .where(and(eq(t.modelBomCache.brandKey, machine.brandKey), eq(t.modelBomCache.modelKey, machine.modelKey)));
  const s = await getSettings(db);
  const baselines = await getBaselines(db);
  const parts = await q<MpnRow & { diagram_id: string; edge_description: string; state: string | null }>(db, sql`
    select x.*, e.diagram_id, e.description edge_description, ps.state
    from model_part_edges e
    join (${MPN_SELECT(s.donorAvailabilities)}) x on x.mpn_canonical = e.mpn_canonical
    left join machine_part_state ps on ps.machine_no = ${machineNo} and ps.mpn_canonical = e.mpn_canonical
    where e.brand_key = ${machine.brandKey} and e.model_key = ${machine.modelKey}`);
  const performance = await roadrunnerPerformance(db, parts.map((p) => p.mpn_canonical));
  const evaluated = parts.map((p) => ({ ...evaluateMpn(p, s, baselines), diagram_id: p.diagram_id, state: p.state,
    suspect: machine.suspectFamilies.includes(p.part_family), roadrunner: performance.get(p.mpn_canonical) ?? null }));
  evaluated.sort((a, b) => {
    const order = (r: typeof a) => {
      const res = r.qualification?.result;
      return res === "QUALIFIED" ? 0 : res === "NEEDS_DATA" ? 1 : res === "SET_RULE" ? 2 : r.market === "missing" && !r.prefilter ? 3 : 4;
    };
    return order(a) - order(b) || valueOf(b) - valueOf(a) || a.diagram_id.localeCompare(b.diagram_id);
  });
  return { machine, bom, parts: evaluated, settings: s };
}

export async function setPartState(db: Db, machineNo: string, mpnCanonical: string, state: "pulled" | "failed" | "missing" | "skip" | null, note?: string) {
  if (state === null) {
    await db.delete(t.machinePartState).where(and(eq(t.machinePartState.machineNo, machineNo), eq(t.machinePartState.mpnCanonical, mpnCanonical)));
    return;
  }
  await db.insert(t.machinePartState).values({ machineNo, mpnCanonical, state, note: note ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [t.machinePartState.machineNo, t.machinePartState.mpnCanonical], set: { state, note: note ?? null, updatedAt: new Date() } });
}

export async function researchQueueCsvRows(db: Db) {
  const { rows } = await mpnIndex(db, { view: "queue" }, 100000);
  return rows;
}
