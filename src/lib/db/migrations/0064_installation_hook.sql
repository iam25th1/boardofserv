ALTER TABLE "connections" DROP CONSTRAINT "connections_provider";--> statement-breakpoint
ALTER TABLE "agent_installations" ADD COLUMN "hook_secret" text;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD COLUMN "hook_lookup" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_installations_hook_idx" ON "agent_installations" USING btree ("hook_lookup");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('telegram', 'google', 'typeform', 'discord', 'slack', 'resend', 'twilio', 'tally', 'airtable', 'notion', 'github', 'gitlab', 'linear', 'jira', 'shopify', 'stripe', 'gumroad', 'lemonsqueezy', 'etherscan', 'alchemy', 'calcom', 'calendly', 'hubspot', 'custom'));