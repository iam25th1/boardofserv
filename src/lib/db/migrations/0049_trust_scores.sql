CREATE TABLE IF NOT EXISTS "trust_history" (
	"subject" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"day" text NOT NULL,
	"score" integer NOT NULL,
	CONSTRAINT "trust_history_subject_subject_id_day_pk" PRIMARY KEY("subject","subject_id","day")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trust_scores" (
	"subject" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"label" text NOT NULL,
	"is_new" boolean NOT NULL,
	"factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_scores_subject_subject_id_pk" PRIMARY KEY("subject","subject_id"),
	CONSTRAINT "trust_scores_subject" CHECK ("trust_scores"."subject" in ('version', 'maker')),
	CONSTRAINT "trust_scores_range" CHECK ("trust_scores"."score" between 300 and 850)
);
