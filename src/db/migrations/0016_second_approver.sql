ALTER TABLE "plan_authorisations" ADD COLUMN "first_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "plan_authorisations" ADD COLUMN "first_confirmed_name" text;--> statement-breakpoint
ALTER TABLE "plan_authorisations" ADD COLUMN "first_confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE plan_authorisations DROP CONSTRAINT plan_authorisations_status_chk;--> statement-breakpoint
ALTER TABLE plan_authorisations ADD CONSTRAINT plan_authorisations_status_chk CHECK (status IN ('proposed', 'awaiting_second', 'declined', 'denied', 'authorised', 'used', 'expired'));--> statement-breakpoint
GRANT UPDATE (first_confirmed_by, first_confirmed_name, first_confirmed_at) ON plan_authorisations TO sme_app;