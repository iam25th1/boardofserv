CREATE TABLE IF NOT EXISTS "input_screens" (
	"hash" text PRIMARY KEY NOT NULL,
	"verdict" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
