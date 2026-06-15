ALTER TABLE "backtest_run" ADD COLUMN "backend" text DEFAULT 'sp4_mock' NOT NULL;--> statement-breakpoint
ALTER TABLE "backtest_run" ADD COLUMN "resume_token" text;--> statement-breakpoint
ALTER TABLE "backtest_run" ADD COLUMN "platform_run" jsonb;