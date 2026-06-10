CREATE TABLE IF NOT EXISTS "agent_event" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_task" (
	"id" text PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"source" text NOT NULL,
	"correlation_id" text NOT NULL,
	"dedupe_key" text,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_event_task_idx" ON "agent_event" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "research_task_dedupe_key_uq" ON "research_task" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_task_correlation_idx" ON "research_task" USING btree ("correlation_id");