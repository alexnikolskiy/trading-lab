CREATE TABLE IF NOT EXISTS "backtest_run" (
	"id" text PRIMARY KEY NOT NULL,
	"hypothesis_build_id" text NOT NULL,
	"hypothesis_id" text NOT NULL,
	"strategy_profile_id" text NOT NULL,
	"platform_run_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"status" text NOT NULL,
	"baseline_module_id" text NOT NULL,
	"variant_module_id" text NOT NULL,
	"net_pnl_usd" double precision,
	"net_pnl_pct" double precision,
	"total_trades" integer,
	"win_rate" double precision,
	"profit_factor" double precision,
	"max_drawdown_pct" double precision,
	"expectancy_usd" double precision,
	"sharpe" double precision,
	"top_trade_contribution_pct" double precision,
	"is_fragile" boolean,
	"baseline_metrics" jsonb,
	"delta_net_pnl_usd" double precision,
	"delta_max_drawdown_pct" double precision,
	"artifact_refs" jsonb NOT NULL,
	"platform_contract_version" text NOT NULL,
	"sdk_contract_version" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation" (
	"id" text PRIMARY KEY NOT NULL,
	"backtest_run_id" text NOT NULL,
	"hypothesis_id" text NOT NULL,
	"decision" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"metrics_snapshot" jsonb NOT NULL,
	"thresholds" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hypothesis_build" (
	"id" text PRIMARY KEY NOT NULL,
	"hypothesis_id" text NOT NULL,
	"strategy_profile_id" text NOT NULL,
	"status" text NOT NULL,
	"builder_adapter" text NOT NULL,
	"builder_model" text NOT NULL,
	"bundle_hash" text,
	"bundle_artifact_ref" jsonb,
	"manifest" jsonb,
	"sdk_contract_version" text NOT NULL,
	"bundle_contract_version" text NOT NULL,
	"issues" jsonb NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "backtest_run_idem_uq" ON "backtest_run" USING btree ("hypothesis_id","params_hash","bundle_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backtest_run_hypothesis_idx" ON "backtest_run" USING btree ("hypothesis_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backtest_run_status_idx" ON "backtest_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_backtest_run_idx" ON "evaluation" USING btree ("backtest_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hypothesis_build_hypothesis_idx" ON "hypothesis_build" USING btree ("hypothesis_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hypothesis_build_status_idx" ON "hypothesis_build" USING btree ("status");