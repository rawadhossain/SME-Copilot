ALTER TABLE "counterparties" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_business_source_id_idx" ON "transactions" USING btree ("business_id","source_id") WHERE "transactions"."source_id" is not null;