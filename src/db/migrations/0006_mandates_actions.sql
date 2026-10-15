CREATE TABLE "action_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text NOT NULL,
	"gate_result" jsonb NOT NULL,
	"result" jsonb,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"confirmations" smallint NOT NULL,
	"approved_by" text NOT NULL,
	"signed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"canonical" text NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_proposal_id_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."action_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_proposals_business_created_idx" ON "action_proposals" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "action_proposals_business_key_idx" ON "action_proposals" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "approvals_business_proposal_idx" ON "approvals" USING btree ("business_id","proposal_id");--> statement-breakpoint
CREATE INDEX "mandates_business_active_idx" ON "mandates" USING btree ("business_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_business_version_idx" ON "mandates" USING btree ("business_id","version");--> statement-breakpoint
ALTER TABLE "action_records" ADD CONSTRAINT "action_records_proposal_id_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."action_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON mandates, action_proposals, approvals TO sme_app;--> statement-breakpoint
ALTER TABLE action_proposals ADD CONSTRAINT action_proposals_status_chk CHECK (status IN ('proposed','denied','approved','executing','executed','verified','failed','verification_failed','cancelled','expired'));--> statement-breakpoint
ALTER TABLE action_proposals ADD CONSTRAINT action_proposals_created_by_chk CHECK (created_by IN ('agent','owner','seed'));--> statement-breakpoint
ALTER TABLE approvals ADD CONSTRAINT approvals_confirmations_chk CHECK (confirmations IN (1, 2))
