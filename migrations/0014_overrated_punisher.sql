CREATE TABLE IF NOT EXISTS "strategy_backtest_run" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_profile_id" text NOT NULL,
	"strategy_bundle_id" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"params_hash" text NOT NULL,
	"run_kind" text NOT NULL,
	"platform_run_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"task_id" text,
	"resume_token" text,
	"params" jsonb NOT NULL,
	"status" text NOT NULL,
	"metrics" jsonb,
	"platform_run" jsonb,
	"artifact_refs" jsonb NOT NULL,
	"platform_contract_version" text NOT NULL,
	"sdk_contract_version" text NOT NULL,
	"backend" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "experiment_run_member" ADD COLUMN "strategy_backtest_run_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_backtest_run_idem_uq" ON "strategy_backtest_run" USING btree ("strategy_bundle_id","params_hash","bundle_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_backtest_run_profile_idx" ON "strategy_backtest_run" USING btree ("strategy_profile_id");