CREATE TABLE IF NOT EXISTS "research_token_usage" (
	"correlation_id" text PRIMARY KEY NOT NULL,
	"cumulative_tokens" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
