CREATE TABLE "roadrunner_sale_events" (
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"mpn_canonical" text NOT NULL,
	"mpn_display" text NOT NULL,
	"sold_at" date NOT NULL,
	"quantity" integer NOT NULL,
	"item_price" numeric(10, 2),
	"listed_at" date,
	"days_to_sell" integer,
	"days_to_sell_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roadrunner_sale_events_source_source_event_id_mpn_canonical_pk" PRIMARY KEY("source","source_event_id","mpn_canonical"),
	CONSTRAINT "sale_events_quantity_check" CHECK ("roadrunner_sale_events"."quantity" > 0),
	CONSTRAINT "sale_events_price_check" CHECK ("roadrunner_sale_events"."item_price" is null or "roadrunner_sale_events"."item_price" >= 0),
	CONSTRAINT "sale_events_days_check" CHECK ("roadrunner_sale_events"."days_to_sell" is null or "roadrunner_sale_events"."days_to_sell" >= 0),
	CONSTRAINT "sale_events_days_source_check" CHECK ("roadrunner_sale_events"."days_to_sell_source" is null or "roadrunner_sale_events"."days_to_sell_source" in ('supplied','derived'))
);
--> statement-breakpoint
CREATE INDEX "sale_events_mpn_idx" ON "roadrunner_sale_events" USING btree ("mpn_canonical");