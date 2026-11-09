CREATE TABLE IF NOT EXISTS "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"from" text NOT NULL,
	"text" text NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_triggers" (
	"installation_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"kind" text NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"holds" boolean,
	"last_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "agent_triggers_installation_id_index_pk" PRIMARY KEY("installation_id","index")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_triggers" ADD CONSTRAINT "agent_triggers_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_messages_installation_idx" ON "agent_messages" USING btree ("installation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_triggers_due_idx" ON "agent_triggers" USING btree ("next_at");