ALTER TABLE "plan_authorisations" ADD COLUMN "letters" jsonb;--> statement-breakpoint
ALTER TABLE "plan_authorisations" ADD COLUMN "letters_hash" text;--> statement-breakpoint
ALTER TABLE "plan_authorisations" ADD COLUMN "signature_image" text;--> statement-breakpoint
ALTER TABLE "plan_authorisations" ADD COLUMN "signature_hash" text;