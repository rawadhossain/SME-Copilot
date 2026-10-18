CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"automation_name" text NOT NULL,
	"version" integer NOT NULL,
	"dedupe_key" text NOT NULL,
	"entity" text NOT NULL,
	"day" date NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"resume_on" date,
	"resume_node" text,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	CONSTRAINT "automation_runs_status_chk" CHECK ("automation_runs"."status" in ('done', 'waiting', 'stopped', 'failed')),
	CONSTRAINT "automation_runs_dry_chk" CHECK ("automation_runs"."dry_run" = false)
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"graph" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_status_chk" CHECK ("automations"."status" in ('draft', 'enabled', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"role" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"note" text,
	"link" text DEFAULT '/room' NOT NULL,
	"automation_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_to_chk" CHECK ("notifications"."user_id" is not null or "notifications"."role" in ('owner', 'approver'))
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_owner_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."owner_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_dedupe_idx" ON "automation_runs" USING btree ("automation_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "automation_runs_business_idx" ON "automation_runs" USING btree ("business_id","started_at");--> statement-breakpoint
CREATE INDEX "automation_runs_waiting_idx" ON "automation_runs" USING btree ("business_id") WHERE "automation_runs"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "automations_business_idx" ON "automations" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "notifications" USING btree ("business_id","created_at");--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON automations TO sme_app;--> statement-breakpoint
GRANT UPDATE (name, graph, version, status, updated_by, updated_at) ON automations TO sme_app;--> statement-breakpoint
GRANT SELECT, INSERT ON automation_runs TO sme_app;--> statement-breakpoint
GRANT UPDATE (status, finished_at, resume_on, resume_node, results) ON automation_runs TO sme_app;--> statement-breakpoint
GRANT SELECT, INSERT ON notifications TO sme_app;--> statement-breakpoint
GRANT UPDATE (read_at) ON notifications TO sme_app;
