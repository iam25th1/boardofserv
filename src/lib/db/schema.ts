import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, index, uniqueIndex, integer, boolean, numeric, primaryKey, check, bigint } from "drizzle-orm/pg-core";
import { CURRENCIES } from "../money";

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
    // The user's own SERV inference key, encrypted the same way, and its last
    // four characters, the only part ever shown. With it set, their chat and
    // helper uses run on it (see servKey.ts).
    servKeyEncrypted: text("serv_key_encrypted"),
    servKeyLast4: text("serv_key_last4"),
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
// The row is written as the turn starts (so turns running at the same time
// all count against the person's daily limit) and finished when it ends.
// provider is "serv", "dolphin", "fallback" or "demo", or null when nothing
// answered.
// outcome: "ok" (the first provider answered), "fell_back" (a later one did)
// or "failed" (nothing answered, or the reply was cut off mid-stream). Token
// counts are whatever the provider reported, null when it reported none.
// sketch_ok says whether the plan call gave a valid sketch, also when the
// reply then failed (older rows, from before the plan ran first, have null
// when no reply was given).
// Rows outlive their conversation, which is set to null when it is deleted.
// user_id (null on rows from before it was kept) is who the turn was for, so
// the daily limit survives a deleted conversation. kind is "reply" for a
// chat turn, "compile" for the call that writes a published helper's
// instructions (its tokens in the reply columns). own_key marks a call made
// on the person's own SERV key: it is not counted against anything.
export const replyUsage = pgTable(
  "reply_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["reply", "compile"] }).notNull().default("reply"),
    ownKey: boolean("own_key").notNull().default(false),
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
    // Which provider and model the plan call ran on (null on older rows, from
    // before Dolphin, when it could only be SERV or the backup).
    extractProvider: text("extract_provider"),
    extractModel: text("extract_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCreated: index("reply_usage_created_idx").on(t.createdAt),
    byUserDay: index("reply_usage_user_idx").on(t.userId, t.createdAt),
  }),
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
// provider and model say what answered (null on older rows, which were all
// SERV); own_key marks a use made on the person's own SERV key.
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
    provider: text("provider"),
    model: text("model"),
    ownKey: boolean("own_key").notNull().default(false),
    latencyMs: integer("latency_ms").notNull(),
    outcome: text("outcome", { enum: ["ok", "blocked", "failed"] }).notNull(),
    // The hold that pays for a paid use; null for a free one. Only free uses
    // count against the daily limit.
    holdId: uuid("hold_id").references(() => holds.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byUserDay: index("helper_uses_user_idx").on(t.userId, t.createdAt) }),
);

// Money. Every change to anyone's balance is one ledger row, written in the
// same transaction as the balance it changes, and never updated or deleted
// afterwards. The amount is a signed whole number of the currency's minor
// units, stored as a string of digits: positive for a deposit, a maker's
// earning, the platform's fee and a reversed withdrawal; negative for a use's
// charge and a withdrawal. The platform's own rows (its fee from each paid
// use) have no user. The idempotency key is unique, so the same credit or
// payout can never be written twice (see src/lib/payments/ledger.ts).
export const LEDGER_KINDS = ["deposit", "use_charge", "maker_earning", "platform_fee", "withdrawal", "withdrawal_reversal"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id),
    currency: text("currency", { enum: CURRENCIES }).notNull(),
    amount: text("amount").notNull(),
    kind: text("kind", { enum: LEDGER_KINDS }).notNull(),
    // What the entry is about: a deposit, a hold or a withdrawal id.
    referenceId: text("reference_id"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byUser: index("ledger_entries_user_idx").on(t.userId, t.currency, t.createdAt),
    knownCurrency: check("ledger_entries_currency", sql`${t.currency} in ('USDC', 'SERV')`),
    knownKind: check(
      "ledger_entries_kind",
      sql`${t.kind} in ('deposit', 'use_charge', 'maker_earning', 'platform_fee', 'withdrawal', 'withdrawal_reversal')`,
    ),
    wholeNumber: check("ledger_entries_amount_whole", sql`${t.amount} ~ '^-?[1-9][0-9]{0,77}$'`),
    signByKind: check("ledger_entries_sign", sql`(${t.kind} in ('use_charge', 'withdrawal')) = (${t.amount} like '-%')`),
    platformHasNoUser: check("ledger_entries_platform", sql`(${t.kind} = 'platform_fee') = (${t.userId} is null)`),
  }),
);

// Each user's balance in each currency, in minor units: available to spend
// or withdraw, and held for uses still running. The database refuses either
// going below zero. The sum of a user's ledger rows in a currency always
// equals available plus held.
export const balances = pgTable(
  "balances",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    currency: text("currency", { enum: CURRENCIES }).notNull(),
    available: numeric("available", { precision: 78, scale: 0 }).notNull().default("0"),
    held: numeric("held", { precision: 78, scale: 0 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.currency] }),
    knownCurrency: check("balances_currency", sql`${t.currency} in ('USDC', 'SERV')`),
    availableNotNegative: check("balances_available_not_negative", sql`${t.available} >= 0`),
    heldNotNegative: check("balances_held_not_negative", sql`${t.held} >= 0`),
  }),
);

// Wallets linked to a user in Privy: the embedded wallet, and any external
// wallet the user linked by signing with it. Privy is the source of truth;
// this copy is brought in step with it when the user opens their wallet page
// or checks for a deposit, and lets the deposit watcher match a transfer's
// sender to a user. Addresses are kept in lower case.
export const linkedWallets = pgTable(
  "linked_wallets",
  {
    address: text("address").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    embedded: boolean("embedded").notNull().default(false),
    linkedAt: timestamp("linked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byUser: index("linked_wallets_user_idx").on(t.userId),
    lowerCase: check("linked_wallets_lower_case", sql`${t.address} = lower(${t.address})`),
  }),
);

// Every token transfer to the treasury the watcher has seen, one row per log
// (chain id, transaction hash, log index). "confirming" until its block has
// enough confirmations; then "credited" to the user whose linked wallet sent
// it, or "unmatched" when no user has that wallet (credited to nobody, listed
// for the admin). "dropped" when a reorg took it away before it confirmed.
export const DEPOSIT_STATUSES = ["confirming", "credited", "unmatched", "dropped"] as const;

export const deposits = pgTable(
  "deposits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    currency: text("currency", { enum: CURRENCIES }).notNull(),
    fromAddress: text("from_address").notNull(),
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    userId: uuid("user_id").references(() => users.id),
    status: text("status", { enum: DEPOSIT_STATUSES }).notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => ({
    onePerLog: uniqueIndex("deposits_log_idx").on(t.chainId, t.txHash, t.logIndex),
    byUser: index("deposits_user_idx").on(t.userId, t.seenAt),
    byStatus: index("deposits_status_idx").on(t.status, t.seenAt),
    knownCurrency: check("deposits_currency", sql`${t.currency} in ('USDC', 'SERV')`),
    knownStatus: check("deposits_status", sql`${t.status} in ('confirming', 'credited', 'unmatched', 'dropped')`),
    positive: check("deposits_amount_positive", sql`${t.amount} > 0`),
  }),
);

// How far a chain scan has got: the last block it finished, so a restart
// resumes from the next one.
export const chainCursors = pgTable("chain_cursors", {
  key: text("key").primaryKey(),
  block: bigint("block", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// What a helper's maker charges per use, in minor units, for each currency
// they accept. No row (or a currency that is off) means that currency is not
// accepted; a helper with no prices is free and keeps the daily limit.
export const helperPrices = pgTable(
  "helper_prices",
  {
    helperId: uuid("helper_id")
      .notNull()
      .references(() => publishedHelpers.id, { onDelete: "cascade" }),
    currency: text("currency", { enum: CURRENCIES }).notNull(),
    price: numeric("price", { precision: 78, scale: 0 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.helperId, t.currency] }),
    knownCurrency: check("helper_prices_currency", sql`${t.currency} in ('USDC', 'SERV')`),
    positive: check("helper_prices_positive", sql`${t.price} > 0`),
  }),
);

// The price of a paid use, set aside from the user's balance before the model
// is called. "held" until the use ends: "captured" on a good answer (the
// charge, the maker's 90% and the platform's 10% are posted), "released" on
// a failed or blocked one, or by the sweep once it is older than ten minutes.
// A hold changes state once only, so it is never both charged and given back.
export const HOLD_STATUSES = ["held", "captured", "released"] as const;

export const holds = pgTable(
  "holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    currency: text("currency", { enum: CURRENCIES }).notNull(),
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    helperId: uuid("helper_id").references(() => publishedHelpers.id, { onDelete: "set null" }),
    makerUserId: uuid("maker_user_id")
      .notNull()
      .references(() => users.id),
    status: text("status", { enum: HOLD_STATUSES }).notNull().default("held"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => ({
    byStatus: index("holds_status_idx").on(t.status, t.createdAt),
    knownCurrency: check("holds_currency", sql`${t.currency} in ('USDC', 'SERV')`),
    knownStatus: check("holds_status", sql`${t.status} in ('held', 'captured', 'released')`),
    positive: check("holds_amount_positive", sql`${t.amount} > 0`),
  }),
);

// A maker taking money out to one of their linked wallets. The amount is
// debited (a "withdrawal" ledger row) when it is asked for. Then:
// "awaiting_approval" (over the automatic limit or the day's cap) or
// "queued" (paid automatically); "broadcast" once the payout transaction is
// signed and sent, with its nonce, hash and signed bytes recorded first, so a
// resend is the very same transaction; "paid" once it has enough
// confirmations. "reverted" (the transfer failed on chain), "rejected" (by an
// admin, before it was sent) and "failed" (an admin found it never went out)
// each post a "withdrawal_reversal" that gives the amount back. At most one
// payout is in flight per chain at a time: the database refuses a second
// "broadcast" row.
export const WITHDRAWAL_STATUSES = ["awaiting_approval", "queued", "broadcast", "paid", "reverted", "rejected", "failed"] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    chainId: integer("chain_id").notNull(),
    currency: text("currency", { enum: CURRENCIES }).notNull(),
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    toAddress: text("to_address").notNull(),
    status: text("status", { enum: WITHDRAWAL_STATUSES }).notNull(),
    // Paid without approval, and so counted against the day's cap.
    auto: boolean("auto").notNull(),
    // Why it waits for approval, for the user and the admin.
    reason: text("reason"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    // The address that signed the payout, with its nonce.
    fromAddress: text("from_address"),
    nonce: integer("nonce"),
    txHash: text("tx_hash"),
    rawTx: text("raw_tx"),
    broadcastAt: timestamp("broadcast_at", { withTimezone: true }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    sends: integer("sends").notNull().default(0),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byUser: index("withdrawals_user_idx").on(t.userId, t.createdAt),
    byStatus: index("withdrawals_status_idx").on(t.status, t.createdAt),
    oneInFlight: uniqueIndex("withdrawals_one_in_flight").on(t.chainId).where(sql`${t.status} = 'broadcast'`),
    oneNonce: uniqueIndex("withdrawals_nonce_idx").on(t.chainId, t.nonce).where(sql`${t.status} in ('broadcast', 'paid', 'reverted')`),
    knownCurrency: check("withdrawals_currency", sql`${t.currency} in ('USDC', 'SERV')`),
    knownStatus: check(
      "withdrawals_status",
      sql`${t.status} in ('awaiting_approval', 'queued', 'broadcast', 'paid', 'reverted', 'rejected', 'failed')`,
    ),
    positive: check("withdrawals_amount_positive", sql`${t.amount} > 0`),
    sentHasHash: check("withdrawals_sent_has_hash", sql`${t.status} not in ('broadcast', 'paid', 'reverted') or (${t.txHash} is not null and ${t.nonce} is not null)`),
  }),
);

// Switches the admin flips without a restart. "payouts_paused" = "true"
// stops every payout from being sent.
export const paymentSettings = pgTable("payment_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentSketchRow = typeof agentSketches.$inferSelect;
export type PublishedHelper = typeof publishedHelpers.$inferSelect;
