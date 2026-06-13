CREATE TABLE IF NOT EXISTS "chat_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"after_task_id" text NOT NULL,
	"next_task_type" text NOT NULL,
	"resolve_profile_by_fingerprint" text NOT NULL,
	"correlation_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_session" (
	"session_id" text PRIMARY KEY NOT NULL,
	"last_strategy_profile_id" text,
	"last_research_task_id" text,
	"last_hypothesis_id" text,
	"last_backtest_run_id" text,
	"last_user_goal" text,
	"pending_plan_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_plan_after_task_status_idx" ON "chat_plan" USING btree ("after_task_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_plan_session_idx" ON "chat_plan" USING btree ("session_id");