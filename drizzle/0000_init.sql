CREATE TABLE "fleet_machines" (
	"machine_no" text PRIMARY KEY NOT NULL,
	"availability" text DEFAULT 'UNCHECKED' NOT NULL,
	"appliance_type" text DEFAULT '' NOT NULL,
	"configuration" text,
	"brand" text DEFAULT '' NOT NULL,
	"brand_key" text DEFAULT '' NOT NULL,
	"model_raw" text DEFAULT '' NOT NULL,
	"model_key" text DEFAULT '' NOT NULL,
	"serial" text DEFAULT '' NOT NULL,
	"color" text,
	"condition" text,
	"location" text,
	"diagnosis" text,
	"notes" text,
	"list_price" numeric(10, 2),
	"acquired_at" date,
	"identity_status" text DEFAULT 'ok' NOT NULL,
	"suspect_families" text[] DEFAULT '{}'::text[] NOT NULL,
	"age_family" text,
	"age_candidate_years" integer[] DEFAULT '{}'::int[] NOT NULL,
	"age_month" integer,
	"age_week" integer,
	"age_confidence" text DEFAULT 'none' NOT NULL,
	"age_note" text,
	"source" text DEFAULT 'import' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_identity_check" CHECK ("fleet_machines"."identity_status" in ('ok','needs_nameplate')),
	CONSTRAINT "fleet_age_conf_check" CHECK ("fleet_machines"."age_confidence" in ('unique','ambiguous','none'))
);
--> statement-breakpoint
CREATE TABLE "machine_part_state" (
	"machine_no" text NOT NULL,
	"mpn_canonical" text NOT NULL,
	"state" text NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_part_state_machine_no_mpn_canonical_pk" PRIMARY KEY("machine_no","mpn_canonical"),
	CONSTRAINT "part_state_check" CHECK ("machine_part_state"."state" in ('pulled','failed','missing','skip'))
);
--> statement-breakpoint
CREATE TABLE "market_facts" (
	"mpn_canonical" text PRIMARY KEY NOT NULL,
	"sold_90" integer,
	"avg_price" numeric(10, 2),
	"avg_ship" numeric(10, 2),
	"sell_through_pct" numeric(6, 2),
	"active_qty" integer,
	"free_shipping" boolean DEFAULT false NOT NULL,
	"ship_cost" numeric(10, 2),
	"qty_on_hand" integer,
	"researched_at" date,
	"source" text DEFAULT 'manual' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_bom_cache" (
	"brand_key" text NOT NULL,
	"model_key" text NOT NULL,
	"brand_display" text NOT NULL,
	"model_display" text NOT NULL,
	"status" text NOT NULL,
	"source" text,
	"source_url" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"dropped_rows" integer DEFAULT 0 NOT NULL,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_bom_cache_brand_key_model_key_pk" PRIMARY KEY("brand_key","model_key"),
	CONSTRAINT "bom_status_check" CHECK ("model_bom_cache"."status" in ('found','not_found','error'))
);
--> statement-breakpoint
CREATE TABLE "model_part_edges" (
	"brand_key" text NOT NULL,
	"model_key" text NOT NULL,
	"mpn_canonical" text NOT NULL,
	"mpn_display" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"diagram_id" text DEFAULT '' NOT NULL,
	"supplier_part_id" text,
	"new_price" numeric(10, 2),
	"nla" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "model_part_edges_brand_key_model_key_mpn_canonical_pk" PRIMARY KEY("brand_key","model_key","mpn_canonical")
);
--> statement-breakpoint
CREATE TABLE "mpn_alias" (
	"alias_canonical" text PRIMARY KEY NOT NULL,
	"mpn_canonical" text NOT NULL,
	"kind" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	CONSTRAINT "alias_kind_check" CHECK ("mpn_alias"."kind" in ('supersedes','wp_prefix','variant'))
);
--> statement-breakpoint
CREATE TABLE "mpn_master" (
	"mpn_canonical" text PRIMARY KEY NOT NULL,
	"mpn_display" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"part_family" text DEFAULT 'other' NOT NULL,
	"appliance_hint" text,
	"new_price_min" numeric(10, 2),
	"removal_min" numeric(6, 1),
	"removal_source" text,
	"force_research" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "removal_baselines" (
	"appliance" text NOT NULL,
	"component" text NOT NULL,
	"minutes" numeric(6, 1) NOT NULL,
	CONSTRAINT "removal_baselines_appliance_component_pk" PRIMARY KEY("appliance","component")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"fee_pct" numeric(5, 2) DEFAULT '25.00' NOT NULL,
	"default_ship_cost" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"min_sell_through_pct" numeric(5, 2) DEFAULT '20.00' NOT NULL,
	"harvest_cushion" numeric(10, 2) DEFAULT '20.00' NOT NULL,
	"min_profit" numeric(10, 2) DEFAULT '1.00' NOT NULL,
	"labor_rate_hr" numeric(10, 2) DEFAULT '15.00' NOT NULL,
	"machine_overhead" numeric(10, 2) DEFAULT '30.00' NOT NULL,
	"stock_window_days" integer DEFAULT 30 NOT NULL,
	"batch_size" integer DEFAULT 10 NOT NULL,
	"market_stale_days" integer DEFAULT 30 NOT NULL,
	"donor_availabilities" text[] DEFAULT '{UNCHECKED,PARTS ONLY,NEEDS PARTS,PARTS PROGRAM}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX "fleet_model_idx" ON "fleet_machines" USING btree ("brand_key","model_key");--> statement-breakpoint
CREATE INDEX "fleet_availability_idx" ON "fleet_machines" USING btree ("availability");--> statement-breakpoint
CREATE INDEX "edges_mpn_idx" ON "model_part_edges" USING btree ("mpn_canonical");