CREATE TABLE IF NOT EXISTS "agent_sketches" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"kind" text,
	"watches" text,
	"when" text,
	"how" text,
	"tells" text,
	"asking" text,
	"live" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_sketches" ADD CONSTRAINT "agent_sketches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
