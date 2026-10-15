CREATE TABLE "sandbox_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"lender_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"requested_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"offer" jsonb,
	"reference" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"balance_minor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"structured" jsonb NOT NULL,
	"untrusted" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_payees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"account_ref" text NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"counterparty_id" uuid,
	"created_via" text NOT NULL,
	"bank_details_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"payee_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"scheduled_for" date NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"idempotency_key" text NOT NULL,
	"reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sandbox_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"status" text NOT NULL,
	"agreed_terms" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_applications" ADD CONSTRAINT "sandbox_applications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_applications" ADD CONSTRAINT "sandbox_applications_lender_id_counterparties_id_fk" FOREIGN KEY ("lender_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_applications" ADD CONSTRAINT "sandbox_applications_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_bank_accounts" ADD CONSTRAINT "sandbox_bank_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_bank_accounts" ADD CONSTRAINT "sandbox_bank_accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_messages" ADD CONSTRAINT "sandbox_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_messages" ADD CONSTRAINT "sandbox_messages_thread_id_sandbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."sandbox_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_messages" ADD CONSTRAINT "sandbox_messages_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_payees" ADD CONSTRAINT "sandbox_payees_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_payees" ADD CONSTRAINT "sandbox_payees_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_payments" ADD CONSTRAINT "sandbox_payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_payments" ADD CONSTRAINT "sandbox_payments_bank_account_id_sandbox_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."sandbox_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_payments" ADD CONSTRAINT "sandbox_payments_payee_id_sandbox_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."sandbox_payees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_payments" ADD CONSTRAINT "sandbox_payments_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_threads" ADD CONSTRAINT "sandbox_threads_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_threads" ADD CONSTRAINT "sandbox_threads_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_applications_business_idx" ON "sandbox_applications" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_applications_business_key_idx" ON "sandbox_applications" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "sandbox_bank_accounts_business_idx" ON "sandbox_bank_accounts" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "sandbox_messages_business_thread_idx" ON "sandbox_messages" USING btree ("business_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_payees_business_idx" ON "sandbox_payees" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "sandbox_payments_business_due_idx" ON "sandbox_payments" USING btree ("business_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_payments_business_key_idx" ON "sandbox_payments" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "sandbox_threads_business_cp_idx" ON "sandbox_threads" USING btree ("business_id","counterparty_id","created_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sandbox_bank_accounts, sandbox_payees, sandbox_payments, sandbox_threads, sandbox_messages, sandbox_applications TO sme_app;--> statement-breakpoint
ALTER TABLE sandbox_payees ADD CONSTRAINT sandbox_payees_created_via_chk CHECK (created_via IN ('seed', 'agent'));--> statement-breakpoint
ALTER TABLE sandbox_payments ADD CONSTRAINT sandbox_payments_status_chk CHECK (status IN ('scheduled', 'executed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE sandbox_payments ADD CONSTRAINT sandbox_payments_amount_chk CHECK (amount_minor > 0);--> statement-breakpoint
ALTER TABLE sandbox_threads ADD CONSTRAINT sandbox_threads_status_chk CHECK (status IN ('open', 'agreed', 'countered', 'rejected'));--> statement-breakpoint
ALTER TABLE sandbox_messages ADD CONSTRAINT sandbox_messages_direction_chk CHECK (direction IN ('outbound', 'inbound'));--> statement-breakpoint
ALTER TABLE sandbox_messages ADD CONSTRAINT sandbox_messages_kind_chk CHECK (kind IN ('proposal', 'response', 'notice'));--> statement-breakpoint
ALTER TABLE sandbox_messages ADD CONSTRAINT sandbox_messages_inbound_untrusted_chk CHECK (direction = 'outbound' OR untrusted);--> statement-breakpoint
ALTER TABLE sandbox_applications ADD CONSTRAINT sandbox_applications_status_chk CHECK (status IN ('submitted', 'offered', 'declined'));--> statement-breakpoint
ALTER TABLE sandbox_applications ADD CONSTRAINT sandbox_applications_amount_chk CHECK (requested_amount_minor > 0);
