import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Parts Engine owns its own Neon database. It never writes to Ledger,
 * EbayDecisions or Image Finder databases (no cross-database foreign keys).
 */

// ---------------------------------------------------------------------------
// Settings — every threshold lives here, never as a literal.
// Current qualification model: Roadrunner Store Economics v7 (src/lib/economics.ts).
// ---------------------------------------------------------------------------
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  // Legacy prototype GREENLIGHT columns. Kept for compatibility; they no longer drive any decision.
  feePct: numeric("fee_pct", { precision: 5, scale: 2 }).notNull().default("25.00"),
  defaultShipCost: numeric("default_ship_cost", { precision: 10, scale: 2 }).notNull().default("0.00"),
  minSellThroughPct: numeric("min_sell_through_pct", { precision: 5, scale: 2 }).notNull().default("20.00"),
  harvestCushion: numeric("harvest_cushion", { precision: 10, scale: 2 }).notNull().default("20.00"),
  minProfit: numeric("min_profit", { precision: 10, scale: 2 }).notNull().default("1.00"),
  stockWindowDays: integer("stock_window_days").notNull().default(30),
  // Non-management operations labor rate (v7: $15/hour), used for removal labor.
  laborRateHr: numeric("labor_rate_hr", { precision: 10, scale: 2 }).notNull().default("15.00"),
  // Whole-machine acquisition overhead; not part of harvested-part qualification.
  machineOverhead: numeric("machine_overhead", { precision: 10, scale: 2 }).notNull().default("30.00"),
  // Store Economics v7 planning assumptions.
  finalValueFeePct: numeric("final_value_fee_pct", { precision: 5, scale: 2 }).notNull().default("13.60"),
  promotedListingPct: numeric("promoted_listing_pct", { precision: 5, scale: 2 }).notNull().default("3.62"),
  marketplaceTaxPct: numeric("marketplace_tax_pct", { precision: 5, scale: 2 }).notNull().default("6.56"),
  perOrderFee: numeric("per_order_fee", { precision: 10, scale: 2 }).notNull().default("0.40"),
  defaultShipLabel: numeric("default_ship_label", { precision: 10, scale: 2 }).notNull().default("9.00"),
  packShipLabor: numeric("pack_ship_labor", { precision: 10, scale: 2 }).notNull().default("1.50"),
  ordinarySold90Minimum: integer("ordinary_sold_90_minimum").notNull().default(3),
  // Owner-set qualification thresholds. Deliberately null (unset) until entered.
  minimumSellThroughPct: numeric("minimum_sell_through_pct", { precision: 5, scale: 2 }),
  minimumProfitMarginPct: numeric("minimum_profit_margin_pct", { precision: 5, scale: 2 }),
  // Machine-type overhead per quick-sale harvested part.
  overheadRefrigerator: numeric("overhead_refrigerator", { precision: 10, scale: 2 }).notNull().default("3.48"),
  overheadWasher: numeric("overhead_washer", { precision: 10, scale: 2 }).notNull().default("4.65"),
  overheadRange: numeric("overhead_range", { precision: 10, scale: 2 }).notNull().default("5.07"),
  overheadDryer: numeric("overhead_dryer", { precision: 10, scale: 2 }).notNull().default("5.43"),
  overheadDishwasher: numeric("overhead_dishwasher", { precision: 10, scale: 2 }).notNull().default("5.91"),
  overheadFallback: numeric("overhead_fallback", { precision: 10, scale: 2 }).notNull().default("5.07"),
  batchSize: integer("batch_size").notNull().default(10),
  marketStaleDays: integer("market_stale_days").notNull().default(30),
  donorAvailabilities: text("donor_availabilities").array().notNull()
    .default(sql`'{UNCHECKED,PARTS ONLY,NEEDS PARTS,PARTS PROGRAM}'::text[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [check("settings_singleton", sql`${t.id} = 1`)]);

// ---------------------------------------------------------------------------
// Fleet — every machine on the lot. Purchaser fields are never imported.
// ---------------------------------------------------------------------------
export const fleetMachines = pgTable("fleet_machines", {
  machineNo: text("machine_no").primaryKey(),
  availability: text("availability").notNull().default("UNCHECKED"),
  applianceType: text("appliance_type").notNull().default(""),
  configuration: text("configuration"),
  brand: text("brand").notNull().default(""),
  brandKey: text("brand_key").notNull().default(""),
  modelRaw: text("model_raw").notNull().default(""),
  modelKey: text("model_key").notNull().default(""),
  serial: text("serial").notNull().default(""),
  color: text("color"),
  condition: text("condition"),
  location: text("location"),
  diagnosis: text("diagnosis"),
  notes: text("notes"),
  listPrice: numeric("list_price", { precision: 10, scale: 2 }),
  acquiredAt: date("acquired_at"),
  identityStatus: text("identity_status").notNull().default("ok"),
  suspectFamilies: text("suspect_families").array().notNull().default(sql`'{}'::text[]`),
  ageFamily: text("age_family"),
  ageCandidateYears: integer("age_candidate_years").array().notNull().default(sql`'{}'::int[]`),
  ageMonth: integer("age_month"),
  ageWeek: integer("age_week"),
  ageConfidence: text("age_confidence").notNull().default("none"),
  ageNote: text("age_note"),
  source: text("source").notNull().default("import"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  index("fleet_model_idx").on(t.brandKey, t.modelKey),
  index("fleet_availability_idx").on(t.availability),
  check("fleet_identity_check", sql`${t.identityStatus} in ('ok','needs_nameplate')`),
  check("fleet_age_conf_check", sql`${t.ageConfidence} in ('unique','ambiguous','none')`)
]);

// ---------------------------------------------------------------------------
// One parts list per brand+model, reused by every machine of that model
// ---------------------------------------------------------------------------
export const modelBomCache = pgTable("model_bom_cache", {
  brandKey: text("brand_key").notNull(),
  modelKey: text("model_key").notNull(),
  brandDisplay: text("brand_display").notNull(),
  modelDisplay: text("model_display").notNull(),
  status: text("status").notNull(),
  source: text("source"),
  sourceUrl: text("source_url"),
  rowCount: integer("row_count").notNull().default(0),
  droppedRows: integer("dropped_rows").notNull().default(0),
  attempts: jsonb("attempts").notNull().default(sql`'[]'::jsonb`),
  warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  primaryKey({ columns: [t.brandKey, t.modelKey] }),
  check("bom_status_check", sql`${t.status} in ('found','not_found','error')`)
]);

/** BOM membership: this MPN is inside this model. Inverted, it is in-fleet fitment. */
export const modelPartEdges = pgTable("model_part_edges", {
  brandKey: text("brand_key").notNull(),
  modelKey: text("model_key").notNull(),
  mpnCanonical: text("mpn_canonical").notNull(),
  mpnDisplay: text("mpn_display").notNull(),
  description: text("description").notNull().default(""),
  diagramId: text("diagram_id").notNull().default(""),
  supplierPartId: text("supplier_part_id"),
  newPrice: numeric("new_price", { precision: 10, scale: 2 }),
  nla: boolean("nla").notNull().default(false),
  source: text("source").notNull()
}, (t) => [
  primaryKey({ columns: [t.brandKey, t.modelKey, t.mpnCanonical] }),
  index("edges_mpn_idx").on(t.mpnCanonical)
]);

export const mpnMaster = pgTable("mpn_master", {
  mpnCanonical: text("mpn_canonical").primaryKey(),
  mpnDisplay: text("mpn_display").notNull(),
  description: text("description").notNull().default(""),
  partFamily: text("part_family").notNull().default("other"),
  applianceHint: text("appliance_hint"),
  newPriceMin: numeric("new_price_min", { precision: 10, scale: 2 }),
  removalMin: numeric("removal_min", { precision: 6, scale: 1 }),
  removalSource: text("removal_source"),
  forceResearch: boolean("force_research").notNull().default(false),
  /** Packaging cost per part; null is planned as $0 (v7 workbook behavior). */
  packagingCost: numeric("packaging_cost", { precision: 10, scale: 2 }),
  /** Owner-approved exception to the ordinary 90-day sold-count minimum only. */
  strategicExceptionApproved: boolean("strategic_exception_approved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

/** WP prefix, supersessions, typos. Every lookup resolves alias → canonical. */
export const mpnAlias = pgTable("mpn_alias", {
  aliasCanonical: text("alias_canonical").primaryKey(),
  mpnCanonical: text("mpn_canonical").notNull(),
  kind: text("kind").notNull(),
  source: text("source").notNull().default("manual")
}, (t) => [check("alias_kind_check", sql`${t.kind} in ('supersedes','wp_prefix','variant')`)]);

/**
 * Market evidence per MPN. Entered by hand or imported from EbayDecisions / the decision workbook.
 * sold_90 and active_qty are separate facts; exact-MPN sell-through is never derived from them.
 * source is a stable non-PII label (never the uploaded filename).
 */
export const marketFacts = pgTable("market_facts", {
  mpnCanonical: text("mpn_canonical").primaryKey(),
  sold90: integer("sold_90"),
  avgPrice: numeric("avg_price", { precision: 10, scale: 2 }),
  avgShip: numeric("avg_ship", { precision: 10, scale: 2 }),
  sellThroughPct: numeric("sell_through_pct", { precision: 6, scale: 2 }),
  /** Provenance of the exact-MPN sell-through value: 'manual' | 'research', null when there is none. */
  sellThroughSource: text("sell_through_source"),
  activeQty: integer("active_qty"),
  freeShipping: boolean("free_shipping").notNull().default(false),
  shipCost: numeric("ship_cost", { precision: 10, scale: 2 }),
  qtyOnHand: integer("qty_on_hand"),
  researchedAt: date("researched_at"),
  source: text("source").notNull().default("manual"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  check("market_facts_sell_through_source_check", sql`(${t.sellThroughPct} is null and ${t.sellThroughSource} is null)
    or (${t.sellThroughPct} is not null and ${t.sellThroughSource} is not null and ${t.sellThroughSource} in ('manual','research'))`)
]);

/**
 * Roadrunner's own realized sales, one row per sale event (order line) per MPN.
 * Separate from market_facts: this is "what has sold for us", not the wider market.
 * mpn_canonical is the D1 key of the MPN as sold (aliases are not applied).
 * Re-imports are idempotent on (source, source_event_id, mpn_canonical).
 * No purchaser fields: no buyer name/username/address/email/phone/payment/ZIP.
 * The uploaded filename is not stored either; it is user-controlled and may carry PII.
 */
export const roadrunnerSaleEvents = pgTable("roadrunner_sale_events", {
  source: text("source").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  mpnCanonical: text("mpn_canonical").notNull(),
  mpnDisplay: text("mpn_display").notNull(),
  soldAt: date("sold_at").notNull(),
  quantity: integer("quantity").notNull(),
  itemPrice: numeric("item_price", { precision: 10, scale: 2 }),
  listedAt: date("listed_at"),
  daysToSell: integer("days_to_sell"),
  daysToSellSource: text("days_to_sell_source"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  primaryKey({ columns: [t.source, t.sourceEventId, t.mpnCanonical] }),
  index("sale_events_mpn_idx").on(t.mpnCanonical),
  check("sale_events_quantity_check", sql`${t.quantity} > 0`),
  check("sale_events_price_check", sql`${t.itemPrice} is null or ${t.itemPrice} >= 0`),
  check("sale_events_days_check", sql`${t.daysToSell} is null or ${t.daysToSell} >= 0`),
  check("sale_events_days_source_check", sql`${t.daysToSellSource} is null or ${t.daysToSellSource} in ('supplied','derived')`)
]);

/** Removal minutes: generic baseline by appliance + component (Removal Time Library). */
export const removalBaselines = pgTable("removal_baselines", {
  appliance: text("appliance").notNull(),
  component: text("component").notNull(),
  minutes: numeric("minutes", { precision: 6, scale: 1 }).notNull()
}, (t) => [primaryKey({ columns: [t.appliance, t.component] })]);

/**
 * Per-machine, per-part state so a gutted machine stops appearing on pick lists,
 * and a part that caused the failure is never pulled for sale.
 */
export const machinePartState = pgTable("machine_part_state", {
  machineNo: text("machine_no").notNull(),
  mpnCanonical: text("mpn_canonical").notNull(),
  state: text("state").notNull(),
  note: text("note"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  primaryKey({ columns: [t.machineNo, t.mpnCanonical] }),
  check("part_state_check", sql`${t.state} in ('pulled','failed','missing','skip')`)
]);
