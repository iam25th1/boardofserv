CREATE TABLE "agent_seen_items" (
	"installation_id" uuid NOT NULL,
	"source" text NOT NULL,
	"item_id" text NOT NULL,
	"job_id" uuid,
	"state" text DEFAULT 'read' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_seen_items_installation_id_source_item_id_pk" PRIMARY KEY("installation_id","source","item_id")
);
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_provider";--> statement-breakpoint
ALTER TABLE "agent_seen_items" ADD CONSTRAINT "agent_seen_items_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_seen_items_job_idx" ON "agent_seen_items" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('telegram', 'google', 'typeform'));