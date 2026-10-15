CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"trigger" jsonb NOT NULL,
	"status" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"mode" text DEFAULT '' NOT NULL,
	"plan_source" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"plan_hash" text NOT NULL,
	"rank" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_business_started_idx" ON "agent_runs" USING btree ("business_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_steps_business_run_seq_idx" ON "agent_steps" USING btree ("business_id","run_id","seq");--> statement-breakpoint
CREATE INDEX "plans_business_run_rank_idx" ON "plans" USING btree ("business_id","run_id","rank");--> statement-breakpoint
GRANT SELECT, INSERT ON agent_runs, agent_steps, plans TO sme_app;--> statement-breakpoint
GRANT UPDATE (status, model, mode, plan_source, finished_at, error) ON agent_runs TO sme_app;--> statement-breakpoint
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_chk CHECK (status IN ('running', 'completed', 'failed', 'refused'));--> statement-breakpoint
ALTER TABLE agent_steps ADD CONSTRAINT agent_steps_kind_chk CHECK (kind IN ('llm_message', 'tool_call', 'tool_result', 'validation', 'note'));--> statement-breakpoint
ALTER TABLE plans ADD CONSTRAINT plans_status_chk CHECK (status IN ('proposed', 'superseded', 'rejected'))
