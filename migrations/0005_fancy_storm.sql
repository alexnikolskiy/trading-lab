CREATE INDEX IF NOT EXISTS "agent_event_created_idx" ON "agent_event" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backtest_run_created_idx" ON "backtest_run" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hypothesis_proposal_created_idx" ON "hypothesis_proposal" USING btree ("created_at","id");