ALTER TABLE "machine_part_state" ADD COLUMN "disposition" text;--> statement-breakpoint
ALTER TABLE "machine_part_state" ADD COLUMN "listed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_part_state" ADD COLUMN "sold_price" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "machine_part_state" ADD COLUMN "repair_machine_no" text;--> statement-breakpoint
ALTER TABLE "machine_part_state" ADD CONSTRAINT "part_state_disposition_valid" CHECK ("machine_part_state"."disposition" is null or ("machine_part_state"."state" = 'pulled' and "machine_part_state"."disposition" in ('ebay','listed','sold','repair')));--> statement-breakpoint
ALTER TABLE "machine_part_state" ADD CONSTRAINT "part_state_sold_price_valid" CHECK (("machine_part_state"."disposition" is not distinct from 'sold') = ("machine_part_state"."sold_price" is not null) and ("machine_part_state"."sold_price" is null or "machine_part_state"."sold_price" >= 0));--> statement-breakpoint
ALTER TABLE "machine_part_state" ADD CONSTRAINT "part_state_repair_machine_valid" CHECK (("machine_part_state"."disposition" is not distinct from 'repair') = ("machine_part_state"."repair_machine_no" is not null));--> statement-breakpoint
ALTER TABLE "machine_part_state" ADD CONSTRAINT "part_state_listed_at_valid" CHECK ("machine_part_state"."listed_at" is null or "machine_part_state"."disposition" in ('listed','sold'));--> statement-breakpoint
CREATE TABLE "machine_part_disposition_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "machine_no" text NOT NULL,
  "mpn_canonical" text NOT NULL,
  "step" text NOT NULL,
  "previous_disposition" text,
  "next_disposition" text,
  "previous_sold_price" numeric(10, 2),
  "sold_price" numeric(10, 2),
  "repair_machine_no" text,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "part_disposition_events_step_valid" CHECK ("step" IN ('ebay','repair','listed','sold','unlisted','back')),
  CONSTRAINT "part_disposition_events_sale_price_valid" CHECK ("sold_price" IS NULL OR "sold_price" >= 0)
);--> statement-breakpoint
ALTER TABLE "machine_part_disposition_events" ADD CONSTRAINT "machine_part_disposition_events_machine_no_fleet_machines_machine_no_fk" FOREIGN KEY ("machine_no") REFERENCES "public"."fleet_machines"("machine_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "part_disposition_events_machine_time_idx" ON "machine_part_disposition_events" USING btree ("machine_no","recorded_at");
