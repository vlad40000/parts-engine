ALTER TABLE "market_facts" ADD COLUMN "sell_through_source" text;--> statement-breakpoint
ALTER TABLE "mpn_master" ADD COLUMN "packaging_cost" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "mpn_master" ADD COLUMN "strategic_exception_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "final_value_fee_pct" numeric(5, 2) DEFAULT '13.60' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "promoted_listing_pct" numeric(5, 2) DEFAULT '3.62' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "marketplace_tax_pct" numeric(5, 2) DEFAULT '6.56' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "per_order_fee" numeric(10, 2) DEFAULT '0.40' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "default_ship_label" numeric(10, 2) DEFAULT '9.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "pack_ship_labor" numeric(10, 2) DEFAULT '1.50' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "ordinary_sold_90_minimum" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "minimum_sell_through_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "minimum_profit_margin_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "overhead_refrigerator" numeric(10, 2) DEFAULT '3.48' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "overhead_washer" numeric(10, 2) DEFAULT '4.65' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "overhead_range" numeric(10, 2) DEFAULT '5.07' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "overhead_dryer" numeric(10, 2) DEFAULT '5.43' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "overhead_dishwasher" numeric(10, 2) DEFAULT '5.91' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "overhead_fallback" numeric(10, 2) DEFAULT '5.07' NOT NULL;--> statement-breakpoint
-- Backfill before the constraint. Sell-through that the old importer derived from sold_90 and
-- active_qty is not exact-MPN evidence: clear it (sold_90 and active_qty are kept as stored).
UPDATE "market_facts" SET "sell_through_pct" = NULL WHERE "source" LIKE '%(sell-through derived)';--> statement-breakpoint
UPDATE "market_facts" SET "sell_through_source" = CASE WHEN "source" = 'manual' THEN 'manual' ELSE 'research' END
  WHERE "sell_through_pct" IS NOT NULL;--> statement-breakpoint
-- Uploaded filenames are user-controlled and may carry PII (#3): replace them with a stable label.
UPDATE "market_facts" SET "source" = 'market_import' WHERE "source" LIKE 'import:%';--> statement-breakpoint
UPDATE "market_facts" SET "source" = left("source", length("source") - length(' (sell-through derived)'))
  WHERE "source" LIKE '% (sell-through derived)';--> statement-breakpoint
ALTER TABLE "market_facts" ADD CONSTRAINT "market_facts_sell_through_source_check" CHECK (("market_facts"."sell_through_pct" is null and "market_facts"."sell_through_source" is null)
    or ("market_facts"."sell_through_pct" is not null and "market_facts"."sell_through_source" is not null and "market_facts"."sell_through_source" in ('manual','research')));