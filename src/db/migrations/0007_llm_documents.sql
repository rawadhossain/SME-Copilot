CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text NOT NULL,
	"result" jsonb NOT NULL,
	"flags" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"purpose" text NOT NULL,
	"mode" text NOT NULL,
	"model" text NOT NULL,
	"request_hash" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_business_created_idx" ON "documents" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "extractions_business_created_idx" ON "extractions" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_business_created_idx" ON "llm_calls" USING btree ("business_id","created_at");--> statement-breakpoint
GRANT SELECT, INSERT ON llm_calls, documents TO sme_app;--> statement-breakpoint
GRANT SELECT, INSERT ON extractions TO sme_app;--> statement-breakpoint
GRANT UPDATE (status, confirmed_at, confirmed_by) ON extractions TO sme_app;--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_kind_chk CHECK (kind IN ('purchase_order', 'supplier_quote', 'other'));--> statement-breakpoint
ALTER TABLE extractions ADD CONSTRAINT extractions_status_chk CHECK (status IN ('pending_confirmation', 'confirmed', 'rejected', 'failed'));--> statement-breakpoint
ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_mode_chk CHECK (mode IN ('live', 'record', 'replay', 'mock'))
