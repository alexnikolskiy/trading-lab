CREATE TABLE IF NOT EXISTS "experiment_evaluation" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"evaluator_version" text NOT NULL,
	"raw_scores" jsonb NOT NULL,
	"flags" jsonb NOT NULL,
	"verdict" text NOT NULL,
	"verdict_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experiment_run_member" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"backtest_run_id" text,
	"role" text NOT NULL,
	"fold_id" integer,
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"symbols" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"params" jsonb,
	"oos" boolean,
	"trade_count" integer,
	"result_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_experiment" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_key" text NOT NULL,
	"experiment_type" text NOT NULL,
	"strategy_profile_id" text NOT NULL,
	"hypothesis_id" text,
	"build_id" text,
	"bundle_hash" text,
	"objective" text,
	"dataset_scope" jsonb NOT NULL,
	"holdout_policy" jsonb NOT NULL,
	"holdout_boundary" jsonb,
	"parameter_grid" jsonb,
	"status" text NOT NULL,
	"verdict" text,
	"verdict_reason" text,
	"aggregate_metrics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiment_evaluation_experiment_idx" ON "experiment_evaluation" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiment_run_member_experiment_idx" ON "experiment_run_member" USING btree ("experiment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "research_experiment_key_uq" ON "research_experiment" USING btree ("experiment_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_experiment_profile_idx" ON "research_experiment" USING btree ("strategy_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_experiment_status_idx" ON "research_experiment" USING btree ("status");