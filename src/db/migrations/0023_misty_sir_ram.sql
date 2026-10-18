ALTER TABLE "notifications" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "resolved_at" timestamp with time zone;
--> statement-breakpoint
GRANT UPDATE (resolution, resolved_at) ON notifications TO sme_app;
