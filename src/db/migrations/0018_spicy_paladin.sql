CREATE TABLE "recovery_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"strategy_authorisation_id" uuid,
	"status" text NOT NULL,
	"events" jsonb NOT NULL,
	"assessment" jsonb NOT NULL,
	"run_id" uuid,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_strategy_authorisation_id_plan_authorisations_id_fk" FOREIGN KEY ("strategy_authorisation_id") REFERENCES "public"."plan_authorisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_fingerprint_idx" ON "recovery_cases" USING btree ("business_id","fingerprint");--> statement-breakpoint
CREATE INDEX "recovery_cases_business_idx" ON "recovery_cases" USING btree ("business_id","created_at");--> statement-breakpoint
ALTER TABLE recovery_cases ADD CONSTRAINT recovery_cases_status_chk CHECK (status IN ('open', 'planned', 'replanned', 'no_plan', 'blocked', 'failed', 'superseded'));--> statement-breakpoint
GRANT SELECT, INSERT ON recovery_cases TO sme_app;--> statement-breakpoint
GRANT UPDATE (status, assessment, run_id, superseded_by, updated_at) ON recovery_cases TO sme_app;
