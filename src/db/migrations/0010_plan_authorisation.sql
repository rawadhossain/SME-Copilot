CREATE TABLE "plan_authorisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"plan_id" text NOT NULL,
	"levers_hash" text NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"mandate_version" integer NOT NULL,
	"mandate_hash" text NOT NULL,
	"status" text NOT NULL,
	"gate_result" jsonb NOT NULL,
	"signature" text,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"signed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plan_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"authorisation_id" uuid NOT NULL,
	"status" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"verification" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "action_proposals" ADD COLUMN "authorisation_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_authorisations" ADD CONSTRAINT "plan_authorisations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_authorisations" ADD CONSTRAINT "plan_authorisations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_executions" ADD CONSTRAINT "plan_executions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_executions" ADD CONSTRAINT "plan_executions_authorisation_id_plan_authorisations_id_fk" FOREIGN KEY ("authorisation_id") REFERENCES "public"."plan_authorisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_authorisations_business_idx" ON "plan_authorisations" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_executions_authorisation_idx" ON "plan_executions" USING btree ("authorisation_id");--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_authorisation_id_fk" FOREIGN KEY ("authorisation_id") REFERENCES "public"."plan_authorisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
GRANT SELECT, INSERT ON plan_authorisations, plan_executions TO sme_app;--> statement-breakpoint
GRANT UPDATE (status, gate_result, signature, approved_by, signed_at) ON plan_authorisations TO sme_app;--> statement-breakpoint
GRANT UPDATE (status, outcome, verification, finished_at, error) ON plan_executions TO sme_app;--> statement-breakpoint
ALTER TABLE plan_authorisations ADD CONSTRAINT plan_authorisations_status_chk CHECK (status IN ('proposed', 'denied', 'authorised', 'used', 'expired'));--> statement-breakpoint
ALTER TABLE plan_executions ADD CONSTRAINT plan_executions_status_chk CHECK (status IN ('running', 'completed', 'needs_replan', 'rolled_back', 'failed', 'verification_failed', 'refused'));--> statement-breakpoint
ALTER TABLE sandbox_threads DROP CONSTRAINT sandbox_threads_status_chk;--> statement-breakpoint
ALTER TABLE sandbox_threads ADD CONSTRAINT sandbox_threads_status_chk CHECK (status IN ('open', 'agreed', 'countered', 'rejected', 'withdrawn'));--> statement-breakpoint
ALTER TABLE sandbox_applications DROP CONSTRAINT sandbox_applications_status_chk;--> statement-breakpoint
ALTER TABLE sandbox_applications ADD CONSTRAINT sandbox_applications_status_chk CHECK (status IN ('submitted', 'offered', 'declined', 'accepted', 'withdrawn'))
