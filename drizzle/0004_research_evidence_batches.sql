CREATE TABLE "research_evidence_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_sha256" text NOT NULL,
	"source" text NOT NULL,
	"parser_version" integer NOT NULL,
	"metadata" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"lifecycle_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "research_evidence_batches_source_sha256_unique" UNIQUE("source_sha256"),
	CONSTRAINT "research_evidence_hash_valid" CHECK ("research_evidence_batches"."source_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "research_evidence_revision_valid" CHECK ("research_evidence_batches"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_evidence_rows" (
	"batch_id" uuid NOT NULL,
	"input_mpn_key" text NOT NULL,
	"mpn_display" text NOT NULL,
	"resolved_mpn_key" text,
	"source_row" integer NOT NULL,
	"owner_decision" text NOT NULL,
	"comparability" text NOT NULL,
	"observation" jsonb NOT NULL,
	CONSTRAINT "research_evidence_rows_batch_id_input_mpn_key_pk" PRIMARY KEY("batch_id","input_mpn_key"),
	CONSTRAINT "research_evidence_decision_valid" CHECK ("research_evidence_rows"."owner_decision" in ('researched','owner_skip','unreviewed')),
	CONSTRAINT "research_evidence_comparability_valid" CHECK ("research_evidence_rows"."comparability" in ('unverified_aggregate','partial_exact_comparable','noncomparable','bundle_risk','unknown','owner_skip')),
	CONSTRAINT "research_evidence_row_valid" CHECK ("research_evidence_rows"."source_row" > 0 and "research_evidence_rows"."input_mpn_key" ~ '^[A-Z0-9]{1,200}$')
);
--> statement-breakpoint
ALTER TABLE "research_evidence_rows" ADD CONSTRAINT "research_evidence_rows_batch_id_research_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."research_evidence_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_evidence_input_idx" ON "research_evidence_rows" USING btree ("input_mpn_key");--> statement-breakpoint
CREATE INDEX "research_evidence_resolved_idx" ON "research_evidence_rows" USING btree ("resolved_mpn_key");