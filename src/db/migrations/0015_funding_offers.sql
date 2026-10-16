CREATE TABLE "funding_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"label" text NOT NULL,
	"offer" jsonb NOT NULL,
	"form" jsonb NOT NULL,
	"offer_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "funding_offers" ADD CONSTRAINT "funding_offers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funding_offers_business_idx" ON "funding_offers" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "funding_offers_active_label_idx" ON "funding_offers" USING btree ("business_id","label") WHERE "funding_offers"."archived_at" is null;
--> statement-breakpoint
GRANT SELECT, INSERT ON funding_offers TO sme_app;--> statement-breakpoint
GRANT UPDATE (archived_at) ON funding_offers TO sme_app;