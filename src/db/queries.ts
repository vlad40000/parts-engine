import { and, eq, inArray, sql } from "drizzle-orm";
import { canonicalizeMpn, wpPrefixTarget } from "@/src/lib/mpn";
import { classifyFamily, libraryAppliance, PREFILTER_SKIP_FAMILIES, ALWAYS_SCRAP_FAMILIES, type PartFamily } from "@/src/lib/part-family";
import { resolveRemoval, SEED_BASELINES, type Baseline } from "@/src/lib/removal";
import { greenlight, minGreenlightPrice, rankScore, type Greenlight, type GreenlightSettings } from "@/src/lib/greenlight";
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
export type AppSettings = GreenlightSettings & {
  defaultShipCost: number;
  machineOverhead: number;
  stockWindowDays: number;
  batchSize: number;
  marketStaleDays: number;
  donorAvailabilities: string[];
};

export async function getSettings(db: Db): Promise<AppSettings> {
  let [row] = await db.select().from(t.settings).where(eq(t.settings.id, 1));
  if (!row) {
    await db.insert(t.settings).values({ id: 1 }).onConflictDoNothing();
    [row] = await db.select().from(t.settings).where(eq(t.settings.id, 1));
  }
  return {
    feePct: Number(row.feePct),
    minSellThroughPct: Number(row.minSellThroughPct),
    harvestCushion: Number(row.harvestCushion),
    minProfit: Number(row.minProfit),
    laborRateHr: Number(row.laborRateHr),
    defaultShipCost: Number(row.defaultShipCost),
    machineOverhead: Number(row.machineOverhead),
    stockWindowDays: row.stockWindowDays,
    batchSize: row.batchSize,
    marketStaleDays: row.marketStaleDays,
    donorAvailabilities: row.donorAvailabilities
  };
}

export async function saveSettings(db: Db, s: AppSettings): Promise<void> {
  const values = {
    id: 1,
    feePct: s.feePct.toFixed(2),
    minSellThroughPct: s.minSellThroughPct.toFixed(2),
    harvestCushion: s.harvestCushion.toFixed(2),
    minProfit: s.minProfit.toFixed(2),
    laborRateHr: s.laborRateHr.toFixed(2),
    defaultShipCost: s.defaultShipCost.toFixed(2),
    machineOverhead: s.machineOverhead.toFixed(2),
    stockWindowDays: s.stockWindowDays,
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
// MPN index: supply depth + market + greenlight
// ---------------------------------------------------------------------------
export type MpnRow = {
  mpn_canonical: string; mpn_display: string; description: string; part_family: PartFamily; new_price_min: string | null;
  removal_min: string | null; removal_source: string | null; force_research: boolean;
  models: number; donors: number; appliance_mode: string | null;
  sold_90: number | null; avg_price: string | null; avg_ship: string | null; sell_through_pct: string | null; active_qty: number | null;
  free_shipping: boolean | null; ship_cost: string | null; qty_on_hand: number | null; researched_at: string | null; market_source: string | null;
};

export type MpnEvaluated = MpnRow & {
  removal: { minutes: number | null; source: string | null; component: string | null };
  market: "missing" | "current" | "stale";
  verdict: Greenlight | null;
  prefilter: string | null;
  rank: { score: number; share: number; flags: string[] } | null;
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
    coalesce(s.models, 0) models, coalesce(s.donors, 0) donors, s.appliance_mode,
    k.sold_90, k.avg_price, k.avg_ship, k.sell_through_pct, k.active_qty, k.free_shipping, k.ship_cost, k.qty_on_hand,
    k.researched_at::text researched_at, k.source market_source
  from mpn_master m
  left join supply s on s.mpn_canonical = m.mpn_canonical
  left join market_facts k on k.mpn_canonical = m.mpn_canonical`;

export function evaluateMpn(row: MpnRow, s: AppSettings, baselines: Baseline[], now = new Date()): MpnEvaluated {
  const removal = resolveRemoval({
    mpnCanonical: row.mpn_canonical,
    appliance: libraryAppliance(row.appliance_mode),
    description: row.description,
    storedMinutes: row.removal_min == null ? null : Number(row.removal_min),
    storedSource: row.removal_source,
    baselines
  });
  const hasMarket = row.sold_90 != null || row.avg_price != null;
  const ageDays = row.researched_at ? (now.getTime() - new Date(row.researched_at).getTime()) / 86_400_000 : Infinity;
  const market: MpnEvaluated["market"] = !hasMarket ? "missing" : ageDays > s.marketStaleDays ? "stale" : "current";

  let prefilter: string | null = null;
  if (ALWAYS_SCRAP_FAMILIES.includes(row.part_family)) prefilter = "Compressor: always scrap.";
  else if (!row.force_research && PREFILTER_SKIP_FAMILIES.includes(row.part_family)) prefilter = `Family "${row.part_family}" is not researched by default.`;
  else if (!row.force_research && row.new_price_min != null) {
    // Unknown removal time → test against zero labor, the most lenient floor.
    const minutes = removal.minutes ?? 0;
    const floor = minGreenlightPrice(minutes, s);
    if (Number(row.new_price_min) < floor) {
      prefilter = `New price $${Number(row.new_price_min).toFixed(2)} is below the $${floor.toFixed(2)} needed` +
        (removal.minutes == null ? " even with zero labor." : ` at ${minutes} min.`);
    }
  }

  let verdict: Greenlight | null = null;
  let rank: MpnEvaluated["rank"] = null;
  if (hasMarket && !ALWAYS_SCRAP_FAMILIES.includes(row.part_family)) {
    verdict = greenlight({
      P: row.avg_price == null ? null : Number(row.avg_price),
      B: row.avg_ship == null ? null : Number(row.avg_ship),
      freeShipping: Boolean(row.free_shipping),
      S: row.ship_cost == null ? s.defaultShipCost : Number(row.ship_cost),
      removalMin: removal.minutes,
      sellThrough90: row.sell_through_pct == null ? null : Number(row.sell_through_pct),
      settings: s
    });
    if (verdict.verdict === "GREENLIGHT") rank = rankScore(verdict.profit, row.sold_90, row.active_qty);
  }
  return { ...row, removal, market, verdict, prefilter, rank };
}

export type MpnFilter = {
  view?: "all" | "greenlight" | "queue" | "reject" | "needs_data" | "prefiltered";
  family?: string;
  q?: string;
};

export async function mpnIndex(db: Db, f: MpnFilter, limit = 200, offset = 0) {
  const s = await getSettings(db);
  const baselines = await getBaselines(db);
  const where = [sql`true`];
  if (f.family) where.push(sql`part_family = ${f.family}`);
  if (f.q) where.push(sql`(mpn_canonical ilike ${"%" + f.q.toUpperCase().replace(/[^A-Z0-9]/g, "") + "%"} or description ilike ${"%" + f.q + "%"})`);
  if (f.view === "greenlight" || f.view === "reject" || f.view === "needs_data") where.push(sql`(sold_90 is not null or avg_price is not null)`);
  const all = await q<MpnRow>(db, sql`select * from (${MPN_SELECT(s.donorAvailabilities)}) x where ${sql.join(where, sql` and `)} order by donors desc, mpn_canonical`);
  let rows = all.map((r) => evaluateMpn(r, s, baselines));
  if (f.view === "greenlight") rows = rows.filter((r) => r.verdict?.verdict === "GREENLIGHT").sort((a, b) => (b.rank?.score ?? 0) - (a.rank?.score ?? 0) || profitOf(b) - profitOf(a));
  if (f.view === "reject") rows = rows.filter((r) => r.verdict?.verdict === "REJECT");
  if (f.view === "needs_data") rows = rows.filter((r) => r.verdict?.verdict === "NEEDS_DATA");
  if (f.view === "queue") rows = rows.filter((r) => r.market !== "current" && !r.prefilter && r.donors > 0);
  if (f.view === "prefiltered") rows = rows.filter((r) => r.prefilter && r.market === "missing");
  const counts = {
    all: all.length,
    greenlight: 0, reject: 0, needs_data: 0, queue: 0, prefiltered: 0
  };
  if (!f.view || f.view === "all") {
    for (const r of rows) {
      if (r.verdict?.verdict === "GREENLIGHT") counts.greenlight += 1;
      else if (r.verdict?.verdict === "REJECT") counts.reject += 1;
      else if (r.verdict?.verdict === "NEEDS_DATA") counts.needs_data += 1;
      if (r.market !== "current" && !r.prefilter && r.donors > 0) counts.queue += 1;
      if (r.prefilter && r.market === "missing") counts.prefiltered += 1;
    }
  }
  return { rows: rows.slice(offset, offset + limit), total: rows.length, counts, settings: s };
}

const profitOf = (r: MpnEvaluated) => (r.verdict && "profit" in r.verdict && r.verdict.profit != null ? r.verdict.profit : 0);

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
  // Physical facts only; the verdict above never decides who is a candidate.
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
        activeQty: r.activeQty,
        freeShipping: r.freeShipping,
        shipCost: r.shipCost == null ? null : r.shipCost.toFixed(2),
        qtyOnHand: r.qtyOnHand == null ? null : Math.round(r.qtyOnHand),
        researchedAt: r.researchedAt ?? new Date().toISOString().slice(0, 10),
        source: r.sellThroughDerived ? `${source} (sell-through derived)` : source,
        updatedAt: new Date()
      };
    });
    await db.insert(t.marketFacts).values(values).onConflictDoUpdate({
      target: t.marketFacts.mpnCanonical,
      set: {
        sold90: sql`excluded.sold_90`, avgPrice: sql`excluded.avg_price`, avgShip: sql`excluded.avg_ship`,
        sellThroughPct: sql`excluded.sell_through_pct`, activeQty: sql`excluded.active_qty`,
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

export async function updateMpnManual(db: Db, canonical: string, patch: { removalMin?: number | null; forceResearch?: boolean; description?: string }) {
  const set: Partial<typeof t.mpnMaster.$inferInsert> = { updatedAt: new Date() };
  if (patch.removalMin !== undefined) {
    set.removalMin = patch.removalMin == null ? null : String(patch.removalMin);
    set.removalSource = patch.removalMin == null ? null : "manual";
  }
  if (patch.forceResearch !== undefined) set.forceResearch = patch.forceResearch;
  if (patch.description !== undefined) set.description = patch.description;
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
// Teardown queue (Station 3.5 PLAN, first cut)
// ---------------------------------------------------------------------------
export type PullLine = {
  mpn_canonical: string; mpn_display: string; description: string; diagram_id: string; family: string;
  profit: number; removal_min: number | null; suspect: boolean;
};
export type TeardownRow = {
  machine_no: string; brand: string; model_raw: string; appliance_type: string; availability: string;
  age_candidate_years: number[]; score: number; lines: PullLine[]; suspect_lines: PullLine[];
};

/**
 * Machine score = Σ profit of greenlit parts still inside it, limited by each MPN's
 * pull cap: ceil(sold90 × share × stockWindowDays / 90) − qty on hand.
 * Parts beyond the cap stay in the machine (the yard is the warehouse).
 * Parts in a family that matches the machine's failure symptom are listed as
 * "test first" and never counted toward the score.
 * $30 machine overhead is NOT subtracted for machines already on hand (D11).
 */
export async function teardownQueue(db: Db, limit = 100): Promise<{ rows: TeardownRow[]; greenlit: number; settings: AppSettings }> {
  const { rows: greenRows, settings: s } = await mpnIndex(db, { view: "greenlight" }, 100000);
  if (!greenRows.length) return { rows: [], greenlit: 0, settings: s };
  const byMpn = new Map(greenRows.map((r) => [r.mpn_canonical, r]));
  const cap = new Map<string, number>();
  for (const r of greenRows) {
    const share = r.rank?.share ?? 1;
    const target = Math.ceil(((r.sold_90 ?? 0) * share * s.stockWindowDays) / 90);
    cap.set(r.mpn_canonical, Math.max(0, target - (r.qty_on_hand ?? 0)));
  }
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

  const machines = new Map<string, TeardownRow & { potential: number }>();
  for (const c of candidates) {
    const m = byMpn.get(c.mpn_canonical);
    if (!m || m.verdict?.verdict !== "GREENLIGHT") continue;
    const row = machines.get(c.machine_no) ?? {
      machine_no: c.machine_no, brand: c.brand, model_raw: c.model_raw, appliance_type: c.appliance_type,
      availability: c.availability, age_candidate_years: c.age_candidate_years, score: 0, potential: 0, lines: [], suspect_lines: []
    };
    const line: PullLine = {
      mpn_canonical: c.mpn_canonical, mpn_display: m.mpn_display, description: m.description || c.description, diagram_id: c.diagram_id,
      family: m.part_family, profit: m.verdict.profit, removal_min: m.removal.minutes,
      suspect: (c.suspect_families ?? []).includes(m.part_family)
    };
    if (line.suspect) row.suspect_lines.push(line);
    else { row.lines.push(line); row.potential += line.profit; }
    machines.set(c.machine_no, row);
  }

  // Greedy allocation of pull caps, best machines first.
  const ordered = [...machines.values()].sort((a, b) => b.potential - a.potential);
  const remaining = new Map(cap);
  for (const m of ordered) {
    const kept: PullLine[] = [];
    for (const line of m.lines.sort((a, b) => b.profit - a.profit)) {
      const left = remaining.get(line.mpn_canonical) ?? 0;
      if (left > 0) {
        kept.push(line);
        remaining.set(line.mpn_canonical, left - 1);
      }
    }
    m.lines = kept;
    m.score = Math.round(kept.reduce((n, l) => n + l.profit, 0) * 100) / 100;
  }
  const rows = ordered.filter((m) => m.lines.length > 0).sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ potential: _p, ...rest }) => rest);
  return { rows, greenlit: greenRows.length, settings: s };
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
    const order = (r: typeof a) => (r.verdict?.verdict === "GREENLIGHT" ? 0 : r.verdict?.verdict === "NEEDS_DATA" ? 1 : r.market === "missing" && !r.prefilter ? 2 : 3);
    return order(a) - order(b) || profitOf(b) - profitOf(a) || a.diagram_id.localeCompare(b.diagram_id);
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
