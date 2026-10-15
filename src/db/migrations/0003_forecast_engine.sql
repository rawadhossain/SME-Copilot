CREATE TABLE "forecast_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"forecast_run_id" uuid NOT NULL,
	"week_index" integer NOT NULL,
	"occurs_on" date NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"kind" "data_kind" NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"label" text NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "paid_on" date;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "reserve_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "reserve_currency" text;--> statement-breakpoint
UPDATE "businesses" SET "reserve_currency" = "base_currency";--> statement-breakpoint
ALTER TABLE "businesses" ALTER COLUMN "reserve_currency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_reserve_valid" CHECK ("reserve_minor" >= 0 AND "reserve_currency" = "base_currency");--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD COLUMN "variant" text DEFAULT 'baseline' NOT NULL;--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD COLUMN "parameters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_on" date;--> statement-breakpoint
ALTER TABLE "forecast_items" ADD CONSTRAINT "forecast_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_items" ADD CONSTRAINT "forecast_items_forecast_run_id_forecast_runs_id_fk" FOREIGN KEY ("forecast_run_id") REFERENCES "public"."forecast_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_items" ADD CONSTRAINT "forecast_items_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forecast_items_business_run_idx" ON "forecast_items" USING btree ("business_id","forecast_run_id","week_index");--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_reserve_currency_currencies_code_fk" FOREIGN KEY ("reserve_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_runs_business_hash_idx" ON "forecast_runs" USING btree ("business_id","input_hash") WHERE "forecast_runs"."input_hash" is not null;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON forecast_items TO sme_app;
