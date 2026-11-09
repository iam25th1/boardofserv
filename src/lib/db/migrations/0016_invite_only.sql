ALTER TABLE "users" ADD COLUMN "access" text DEFAULT 'waiting' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_decided_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_decided_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_access_decided_by_users_id_fk" FOREIGN KEY ("access_decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
