ALTER TABLE "fleet_machines" ADD COLUMN "manufacturer_variation" text;--> statement-breakpoint
ALTER TABLE "fleet_machines" ADD COLUMN "product_code" text;--> statement-breakpoint
ALTER TABLE "fleet_machines" DROP CONSTRAINT "fleet_identity_check";--> statement-breakpoint
ALTER TABLE "fleet_machines" ADD CONSTRAINT "fleet_identity_check" CHECK ("identity_status" IN ('ok','needs_nameplate','needs_variation'));--> statement-breakpoint
-- Old generic LG BOMs are retained but are not evidence for any exact manufacturer variation.
-- Do not infer a variation from a model suffix or serial number.
UPDATE "fleet_machines" SET "identity_status" = 'needs_variation'
 WHERE "brand_key" = 'LG' AND "identity_status" = 'ok';