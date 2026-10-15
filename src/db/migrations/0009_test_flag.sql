ALTER TABLE "businesses" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "businesses" SET "is_test" = true WHERE "name" LIKE '%Sanity%' OR "name" LIKE 'Agent Live %';
