CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"figures" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen_as_of" date NOT NULL,
	"last_seen_as_of" date NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "alerts_severity_chk" CHECK ("alerts"."severity" in ('urgent', 'watch', 'info')),
	CONSTRAINT "alerts_status_chk" CHECK ("alerts"."status" in ('open', 'acknowledged', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_business_idx" ON "alerts" USING btree ("business_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_dedupe_idx" ON "alerts" USING btree ("business_id","dedupe_key") WHERE "alerts"."status" <> 'resolved';--> statement-breakpoint
GRANT SELECT, INSERT ON alerts TO sme_app;--> statement-breakpoint
GRANT UPDATE (last_seen_as_of, last_seen_at, severity, title, detail, figures, refs, status, resolved_at, acknowledged_by, acknowledged_at) ON alerts TO sme_app;
