CREATE TABLE "fleet_field_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"machine_no" text NOT NULL,
	"field" text NOT NULL,
	"previous_value" text,
	"next_value" text,
	"source" text DEFAULT 'tech_note' NOT NULL,
	"tech_note_id" uuid,
	"observed_at" timestamp with time zone,
	"applied" boolean DEFAULT true NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_field_events_field_valid" CHECK ("fleet_field_events"."field" in ('status','condition','location','diagnosis','notes','sticker_price')),
	CONSTRAINT "fleet_field_events_status_history_only" CHECK ("fleet_field_events"."field" <> 'status' or not "fleet_field_events"."applied"),
	CONSTRAINT "fleet_field_events_changed_valid" CHECK ("fleet_field_events"."previous_value" is distinct from "fleet_field_events"."next_value")
);
--> statement-breakpoint
CREATE TABLE "fleet_location_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"machine_no" text NOT NULL,
	"previous_location" text,
	"recorded_location" text NOT NULL,
	"tech_note_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_location" text,
	CONSTRAINT "fleet_location_checks_resolution_valid" CHECK (("fleet_location_checks"."resolved_at" is null) = ("fleet_location_checks"."resolved_location" is null))
);
--> statement-breakpoint
CREATE TABLE "fleet_locations" (
	"name" text PRIMARY KEY NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"on_card" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"source" text DEFAULT 'import' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_locations_name_valid" CHECK (btrim("fleet_locations"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "fleet_part_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"machine_no" text NOT NULL,
	"mpn_canonical" text,
	"mpn_display" text,
	"part_name" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"other_machine" text,
	"applied" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'tech_note' NOT NULL,
	"tech_note_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_part_events_kind_valid" CHECK ("fleet_part_events"."kind" in ('suspected','needed','failed','missing','replaced','removed'))
);
--> statement-breakpoint
CREATE TABLE "tech_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"origin" text NOT NULL,
	"card" text,
	"photo_type" text,
	"photo" "bytea",
	"photo_sha256" text,
	"photo_bytes" integer,
	"reader_model" text,
	"reader_error" text,
	"reading" jsonb,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_plan" jsonb,
	"observed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "tech_notes_status_check" CHECK ("tech_notes"."status" in ('open','applied','discarded')),
	CONSTRAINT "tech_notes_origin_check" CHECK ("tech_notes"."origin" in ('photo','manual'))
);
--> statement-breakpoint
ALTER TABLE "fleet_machines" ADD COLUMN "local_fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_machines" ADD COLUMN "sticker_price" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "fleet_machines" ADD COLUMN "last_field_update_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fleet_status_events" ADD COLUMN "tech_note_id" uuid;--> statement-breakpoint
ALTER TABLE "fleet_status_events" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_part_state" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fleet_field_events" ADD CONSTRAINT "fleet_field_events_machine_no_fleet_machines_machine_no_fk" FOREIGN KEY ("machine_no") REFERENCES "public"."fleet_machines"("machine_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_field_events" ADD CONSTRAINT "fleet_field_events_tech_note_id_tech_notes_id_fk" FOREIGN KEY ("tech_note_id") REFERENCES "public"."tech_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_location_checks" ADD CONSTRAINT "fleet_location_checks_machine_no_fleet_machines_machine_no_fk" FOREIGN KEY ("machine_no") REFERENCES "public"."fleet_machines"("machine_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_location_checks" ADD CONSTRAINT "fleet_location_checks_tech_note_id_tech_notes_id_fk" FOREIGN KEY ("tech_note_id") REFERENCES "public"."tech_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_part_events" ADD CONSTRAINT "fleet_part_events_machine_no_fleet_machines_machine_no_fk" FOREIGN KEY ("machine_no") REFERENCES "public"."fleet_machines"("machine_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_part_events" ADD CONSTRAINT "fleet_part_events_tech_note_id_tech_notes_id_fk" FOREIGN KEY ("tech_note_id") REFERENCES "public"."tech_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fleet_field_events_machine_time_idx" ON "fleet_field_events" USING btree ("machine_no","changed_at");--> statement-breakpoint
CREATE INDEX "fleet_location_checks_open_idx" ON "fleet_location_checks" USING btree ("machine_no") WHERE "fleet_location_checks"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "fleet_part_events_machine_idx" ON "fleet_part_events" USING btree ("machine_no","observed_at");--> statement-breakpoint
CREATE INDEX "tech_notes_created_idx" ON "tech_notes" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "fleet_status_events" ADD CONSTRAINT "fleet_status_events_tech_note_id_tech_notes_id_fk" FOREIGN KEY ("tech_note_id") REFERENCES "public"."tech_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "fleet_locations" ("name", "on_card", "sort_order", "source")
SELECT DISTINCT btrim("location"),
  btrim("location") NOT IN ('$$$SOLD$$$', 'Scraped'),
  CASE btrim("location") WHEN 'Showroom - Main' THEN 10 WHEN 'Showroom - WH' THEN 20 WHEN 'Shop' THEN 30
    WHEN 'ICU' THEN 40 WHEN 'Warehouse' THEN 50 WHEN 'Graveyard' THEN 60 ELSE 100 END,
  'import'
FROM "fleet_machines"
WHERE "location" IS NOT NULL AND btrim("location") <> ''
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
-- Decisions made before this migration still count: newest Fleet status edit or part state per machine.
UPDATE "fleet_machines" f SET "last_field_update_at" = x."at"
FROM (
  SELECT "machine_no", max("at") "at" FROM (
    SELECT "machine_no", "changed_at" "at" FROM "fleet_status_events"
    UNION ALL
    SELECT "machine_no", "updated_at" FROM "machine_part_state"
  ) u GROUP BY "machine_no"
) x
WHERE x."machine_no" = f."machine_no";
