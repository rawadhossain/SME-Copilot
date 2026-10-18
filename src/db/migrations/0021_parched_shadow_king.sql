CREATE TABLE "playbook_settings" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playbook_settings" ADD CONSTRAINT "playbook_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
GRANT SELECT, INSERT ON playbook_settings TO sme_app;--> statement-breakpoint
GRANT UPDATE (settings, version, updated_by, updated_at) ON playbook_settings TO sme_app;
