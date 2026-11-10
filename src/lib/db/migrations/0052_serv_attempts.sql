CREATE TABLE "model_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"provider" text,
	"status" integer,
	"outcome" text NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"retry" integer DEFAULT 0 NOT NULL,
	"empty" boolean DEFAULT false NOT NULL,
	"own_key" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screen_retries" (
	"subject" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screen_retries_subject_subject_id_pk" PRIMARY KEY("subject","subject_id")
);
--> statement-breakpoint
CREATE INDEX "model_attempts_created_idx" ON "model_attempts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_attempts_call_idx" ON "model_attempts" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "screen_retries_next_idx" ON "screen_retries" USING btree ("next_at");
