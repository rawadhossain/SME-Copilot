ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_lifecycle_chk;--> statement-breakpoint
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_lifecycle_chk CHECK (lifecycle IN ('planned', 'needs_replan', 'replanned', 'exhausted', 'executed', 'verification_failed', 'superseded'))
