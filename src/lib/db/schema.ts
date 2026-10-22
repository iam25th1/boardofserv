import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, index, uniqueIndex, integer, boolean } from "drizzle-orm/pg-core";

// A user of boardofserv, keyed by their Privy user id. We store the Privy
// embedded wallet address and, encrypted, the OpenServ API key that this
// wallet's SIWE sign-in produced. The key is ciphertext only (see crypto.ts);
// the plaintext never touches the database or the browser.
//
// The handle is the user's public name (without the @), unique ignoring case.
// New users get a random one like maker_4821 until they choose their own (see
// handles.ts). The email is never public: only its owner's account menu shows it.
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    privyUserId: text("privy_user_id").notNull().unique(),
    email: text("email"),
    handle: text("handle").notNull(),
    handleChosen: boolean("handle_chosen").notNull().default(false),
    walletAddress: text("wallet_address"),
    // OpenServ linkage.
    openservUserId: text("openserv_user_id"),
    openservKeyEncrypted: text("openserv_key_encrypted"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byHandle: uniqueIndex("users_handle_idx").on(sql`lower(${t.handle})`) }),
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byUser: index("conversations_user_idx").on(t.userId, t.updatedAt) }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    // Which model actually answered: "serv" or a fallback model id. Never null
    // for an assistant message so the UI can label the real source.
    source: text("source"),
    sourceLabel: text("source_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byConversation: index("messages_conversation_idx").on(t.conversationId, t.createdAt) }),
);

// One row per reply, to keep model usage visible. Never any message text.
// provider is "serv", "fallback" or "demo", or null when nothing answered.
// outcome: "ok" (the first provider answered), "fell_back" (a later one did)
// or "failed" (nothing answered, or the reply was cut off mid-stream). Token
// counts are whatever the provider reported, null when it reported none.
// sketch_ok says whether the plan call gave a valid sketch, also when the
// reply then failed (older rows, from before the plan ran first, have null
// when no reply was given).
// Rows outlive their conversation, which is set to null when it is deleted.
export const replyUsage = pgTable(
  "reply_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    provider: text("provider"),
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    firstTokenMs: integer("first_token_ms"),
    totalMs: integer("total_ms").notNull(),
    outcome: text("outcome", { enum: ["ok", "fell_back", "failed"] }).notNull(),
    sketchOk: boolean("sketch_ok"),
    // The plan call that runs before the reply (it was the sketch extraction
    // after it, hence the names): its tokens, time and outcome, null when it
    // did not run.
    extractPromptTokens: integer("extract_prompt_tokens"),
    extractCompletionTokens: integer("extract_completion_tokens"),
    extractMs: integer("extract_ms"),
    extractOutcome: text("extract_outcome", { enum: ["ok", "fell_back", "failed"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byCreated: index("reply_usage_created_idx").on(t.createdAt) }),
);

// The agent being sketched in a conversation, one row per conversation. Each
// turn's plan is merged in (see mergeSketch): a value the model sends
// replaces the stored one, a null never wipes it. live stays false until
// agents can run. An answer helper uses takes, does and gives instead of
// watches, when, how and tells.
export const agentSketches = pgTable("agent_sketches", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => conversations.id, { onDelete: "cascade" }),
  name: text("name"),
  kind: text("kind", { enum: ["watcher", "digest", "helper", "answer"] }),
  watches: text("watches"),
  when: text("when"),
  how: text("how"),
  tells: text("tells"),
  takes: text("takes"),
  does: text("does"),
  gives: text("gives"),
  asking: text("asking", { enum: ["watches", "when", "how", "tells", "takes", "does", "gives"] }),
  live: boolean("live").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// An answer helper a maker published from a conversation, for anyone to use
// from the board. system_prompt (written by the compile call, canary line
// included) and canary are server only: no response, log or client ever
// carries them (see helpers.ts and secrecy.test.ts). Unpublishing sets
// unpublished_at and keeps the row, so the slug stays taken and its page can
// say the helper was taken down. A conversation has at most one live helper.
export const publishedHelpers = pgTable(
  "published_helpers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    inputHint: text("input_hint").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    canary: text("canary").notNull(),
    sourceConversationId: uuid("source_conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
  },
  (t) => ({
    byCreated: index("published_helpers_created_idx").on(t.createdAt),
    oneLive: uniqueIndex("published_helpers_live_idx").on(t.sourceConversationId).where(sql`${t.unpublishedAt} is null`),
  }),
);

// One row per use of a published helper: who used which helper, tokens,
// latency and outcome ("ok", "blocked" when the answer was stopped for
// leaking its instructions, "failed" when no answer came). Never the input or
// the answer. The rows also count each user's uses for the daily limit.
export const helperUses = pgTable(
  "helper_uses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    helperId: uuid("helper_id").references(() => publishedHelpers.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    outcome: text("outcome", { enum: ["ok", "blocked", "failed"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byUserDay: index("helper_uses_user_idx").on(t.userId, t.createdAt) }),
);

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentSketchRow = typeof agentSketches.$inferSelect;
export type PublishedHelper = typeof publishedHelpers.$inferSelect;
