ALTER TABLE "fleet_machines" ADD COLUMN "status_override" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "fleet_status_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "machine_no" text NOT NULL,
  "previous_status" text NOT NULL,
  "next_status" text NOT NULL,
  "source" text DEFAULT 'fleet_ui' NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fleet_status_events_machine_no_fk" FOREIGN KEY ("machine_no") REFERENCES "public"."fleet_machines"("machine_no") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "fleet_status_events_changed_valid" CHECK ("previous_status" <> "next_status")
);--> statement-breakpoint
CREATE INDEX "fleet_status_events_machine_time_idx" ON "fleet_status_events" USING btree ("machine_no","changed_at");
