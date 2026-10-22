ALTER TABLE "users" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle_chosen" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Every existing user gets a random handle, as new users do: maker_ and four
-- digits, or eight once four keep colliding.
DO $$
DECLARE
  u record;
  h text;
  tries int;
BEGIN
  FOR u IN SELECT "id" FROM "users" WHERE "handle" IS NULL LOOP
    tries := 0;
    LOOP
      IF tries < 20 THEN
        h := 'maker_' || (1000 + floor(random() * 9000))::int;
      ELSE
        h := 'maker_' || (10000000 + floor(random() * 90000000))::int;
      END IF;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "users" WHERE lower("handle") = h);
      tries := tries + 1;
    END LOOP;
    UPDATE "users" SET "handle" = h WHERE "id" = u."id";
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "handle" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_handle_idx" ON "users" USING btree (lower("handle"));
