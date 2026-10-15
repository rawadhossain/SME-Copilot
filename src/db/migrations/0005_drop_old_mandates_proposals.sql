ALTER TABLE "action_proposals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mandates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "action_proposals" CASCADE;--> statement-breakpoint
DROP TABLE "mandates" CASCADE;--> statement-breakpoint
ALTER TABLE "action_records" DROP CONSTRAINT IF EXISTS "action_records_proposal_id_action_proposals_id_fk";
