CREATE TABLE IF NOT EXISTS "agent_fetch_days" (
	"installation_id" uuid NOT NULL,
	"day" text NOT NULL,
	"fetches" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_fetch_days_installation_id_day_pk" PRIMARY KEY("installation_id","day")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_fetch_days" ADD CONSTRAINT "agent_fetch_days_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
