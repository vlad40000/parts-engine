-- Additive historical stopwatch logs. Does NOT modify operational removal costs.
CREATE TABLE "harvest_time_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "machine_no" text NOT NULL REFERENCES "fleet_machines"("machine_no"),
  "observed_on" date NOT NULL,
  "shared_access_min" numeric(8,2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "harvest_time_access_nonnegative" CHECK ("shared_access_min" >= 0 AND "shared_access_min" <= 1440)
);--> statement-breakpoint
CREATE INDEX "harvest_time_sessions_machine_idx" ON "harvest_time_sessions"("machine_no");--> statement-breakpoint
CREATE TABLE "harvest_time_parts" (
  "session_id" uuid NOT NULL REFERENCES "harvest_time_sessions"("id"),
  "mpn_canonical" text NOT NULL,
  "removal_min" numeric(8,2) NOT NULL,
  "test_min" numeric(8,2) DEFAULT '0' NOT NULL,
  CONSTRAINT "harvest_time_parts_session_id_mpn_canonical_pk" PRIMARY KEY ("session_id", "mpn_canonical"),
  CONSTRAINT "harvest_time_part_minutes_valid" CHECK ("removal_min" >= 0 AND "removal_min" <= 1440 AND "test_min" >= 0 AND "test_min" <= 1440)
);--> statement-breakpoint
CREATE INDEX "harvest_time_parts_mpn_idx" ON "harvest_time_parts"("mpn_canonical");
