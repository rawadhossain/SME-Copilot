CREATE TABLE "sandbox_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"expected_on" date NOT NULL,
	"status" text NOT NULL,
	"backing_type" text NOT NULL,
	"backing_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "constraints" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lifecycle" text DEFAULT 'planned' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "successor_run_id" uuid;--> statement-breakpoint
ALTER TABLE "sandbox_receipts" ADD CONSTRAINT "sandbox_receipts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_receipts" ADD CONSTRAINT "sandbox_receipts_bank_account_id_sandbox_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."sandbox_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_receipts" ADD CONSTRAINT "sandbox_receipts_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_receipts" ADD CONSTRAINT "sandbox_receipts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_receipts_business_idx" ON "sandbox_receipts" USING btree ("business_id","expected_on");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_receipts_business_key_idx" ON "sandbox_receipts" USING btree ("business_id","idempotency_key");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON sandbox_receipts TO sme_app;--> statement-breakpoint
ALTER TABLE sandbox_receipts ADD CONSTRAINT sandbox_receipts_status_chk CHECK (status IN ('scheduled', 'received', 'cancelled'));--> statement-breakpoint
ALTER TABLE sandbox_receipts ADD CONSTRAINT sandbox_receipts_amount_chk CHECK (amount_minor > 0);--> statement-breakpoint
ALTER TABLE sandbox_receipts ADD CONSTRAINT sandbox_receipts_backing_chk CHECK (backing_type IN ('thread', 'application'));--> statement-breakpoint
GRANT UPDATE (parent_run_id, round, constraints, lifecycle, successor_run_id) ON agent_runs TO sme_app;--> statement-breakpoint
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_lifecycle_chk CHECK (lifecycle IN ('planned', 'needs_replan', 'replanned', 'exhausted', 'executed', 'verification_failed'))
