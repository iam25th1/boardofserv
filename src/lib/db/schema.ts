import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, index, uniqueIndex, integer, boolean, numeric, primaryKey, check, bigint, bigserial, json, jsonb, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { AgentDefinition } from "../agents/definition";
import type { BenchData, HealLog, RunState, StepCode, TestResult } from "../agents/types";
import type { JourneyCard } from "../journey";
import { CURRENCIES } from "../money";
import { DISPUTE_REASONS } from "../spending/disputeWords";

// One tab of a Google Sheet an owner gave an installation.
export interface SheetGrant {
  spreadsheetId: string;
  title: string;
  tab: string;
  tabId: number;
}

// A user of boardofserv, keyed by their Privy user id. We store the Privy
// embedded wallet address and, encrypted, the OpenServ API key that this
// wallet's SIWE sign-in produced. The key is ciphertext only (see crypto.ts);
// the plaintext never touches the database or the browser.
//
// The handle is the user's public name (without the @), unique ignoring case.
// New users get a random one like maker_4821 until they choose their own (see
// handles.ts). The email is never public: only its owner's account menu shows
// it, and the admin's list of accounts waiting to get in.
//
// access: while INVITE_ONLY is on, every account starts "waiting" and sees
// the waitlist until an admin approves it ("approved") or turns it away
// ("rejected"); see access.ts. Admins are always let in.
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
    // The agent page shows everything (the step graph, code, test bench and
    // versions) rather than the plain view: the maker's own choice, kept.
    agentDetails: boolean("agent_details").notNull().default(false),
    // Their time zone, as their browser gives it (an IANA name), saved
    // whenever it changes: what their agents' times and tests go by. Null
    // until a browser has said, and then UTC, never the server's.
    timezone: text("timezone"),
    access: text("access", { enum: ["waiting", "approved", "rejected"] }).notNull().default("waiting"),
    accessDecidedBy: uuid("access_decided_by").references((): AnyPgColumn => users.id),
    accessDecidedAt: timestamp("access_decided_at", { withTimezone: true }),
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
    // A stage of making an agent, shown as a card in the chat (journey.ts):
    // its content is what the card says, in words, for the model's history.
    card: jsonb("card").$type<JourneyCard>(),
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
// instructions, and agent_plan, agent_code, agent_review or agent_decision
// for building and testing an agent (each with its tokens in the reply
// columns). own_key marks a call made
// on the person's own SERV key: it is not counted against anything.
export const replyUsage = pgTable(
  "reply_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["reply", "compile", "agent_plan", "agent_code", "agent_review", "agent_decision", "agent_guard", "agent_screen", "agent_vetting"] }).notNull().default("reply"),
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
// agents can run. An answer helper uses takes, does and gives, an agent its
// interview fields, the older kinds watches, when, how and tells.
export const agentSketches = pgTable("agent_sketches", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => conversations.id, { onDelete: "cascade" }),
  name: text("name"),
  kind: text("kind", { enum: ["watcher", "digest", "helper", "answer", "agent"] }),
  watches: text("watches"),
  when: text("when"),
  how: text("how"),
  tells: text("tells"),
  takes: text("takes"),
  does: text("does"),
  gives: text("gives"),
  // An agent's interview (see sketchFields.ts).
  wakes: text("wakes"),
  looks: text("looks"),
  handles: text("handles"),
  finish: text("finish"),
  asks: text("asks"),
  setup: text("setup"),
  remembers: text("remembers"),
  asking: text("asking", { enum: ["watches", "when", "how", "tells", "takes", "does", "gives", "wakes", "looks", "handles", "finish", "asks", "setup", "remembers"] }),
  live: boolean("live").notNull().default(false),
  // The maker picked the kind on the dock; the plan leaves it alone from then on.
  kindChosen: boolean("kind_chosen").notNull().default(false),
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
// refund, earning_reversal and platform_refund are an upheld rent
// dispute's refund (spending/disputes.ts): the renter's money back, the
// maker's share and the platform's reversed. A deploy's schema push doesn't
// change the checks on an existing table, so they wait for the owner's
// scripts/sql/ledger-kinds.sql (and refunds wait until it has run).
export const LEDGER_KINDS = ["deposit", "use_charge", "maker_earning", "platform_fee", "withdrawal", "withdrawal_reversal", "refund", "earning_reversal", "platform_refund"] as const;
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
      sql`${t.kind} in ('deposit', 'use_charge', 'maker_earning', 'platform_fee', 'withdrawal', 'withdrawal_reversal', 'refund', 'earning_reversal', 'platform_refund')`,
    ),
    wholeNumber: check("ledger_entries_amount_whole", sql`${t.amount} ~ '^-?[1-9][0-9]{0,77}$'`),
    signByKind: check("ledger_entries_sign", sql`(${t.kind} in ('use_charge', 'withdrawal', 'earning_reversal', 'platform_refund')) = (${t.amount} like '-%')`),
    platformHasNoUser: check("ledger_entries_platform", sql`(${t.kind} in ('platform_fee', 'platform_refund')) = (${t.userId} is null)`),
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
    // What it is for: a helper's use ("use", swept after ten minutes), a
    // week's rent ("rent", captured at once) or a rented agent's fee for
    // one job ("job_fee", settled when the job ends). Not a checked column:
    // a deploy's schema push adds columns but doesn't change checks.
    kind: text("kind").notNull().default("use"),
    jobId: uuid("job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => ({
    byStatus: index("holds_status_idx").on(t.status, t.createdAt),
    byKind: index("holds_kind_idx").on(t.kind, t.status),
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

// An agent a maker builds from a conversation: the stable identity its
// versions hang from. A conversation has at most one.
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceConversationId: uuid("source_conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    // Its maker stopped it everywhere (the kill switch): every installation
    // paused, renewals held, nothing new rented, until they start it again.
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    stopNote: text("stop_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOwner: index("agents_owner_idx").on(t.ownerUserId, t.updatedAt),
    onePerConversation: uniqueIndex("agents_conversation_idx").on(t.sourceConversationId),
  }),
);

// The versions of an agent, numbered from 1. At most one is a draft, the one
// being planned, written and tested. Publishing turns the draft into a
// version that never changes again: every write to a version is guarded by
// state = 'draft' (see agents/store.ts), and an edit after publishing starts
// a new draft from it. definition is null until the first plan is made.
// code holds each code step's source and review, which only the maker's own
// builder ever shows. bench holds the test bench's sample data. build_state
// says what the background build is doing ("idle", "planning", "writing",
// "fixing" or "failed", with build_note saying why in plain words).
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    state: text("state", { enum: ["draft", "published"] }).notNull().default("draft"),
    definition: jsonb("definition").$type<AgentDefinition>(),
    code: jsonb("code").$type<Record<string, StepCode>>().notNull().default({}),
    bench: jsonb("bench").$type<BenchData>(),
    // The code review before publishing (agents/vetting.ts): its status and
    // findings in plain words, never code.
    review: jsonb("review").$type<{ status: "passed" | "blocked" | "unreviewed"; findings: { step: string; severity: "blocking" | "warning"; finding: string }[]; by: "local" | "serv"; model: string | null; reviewedAt: string }>(),
    buildState: text("build_state", { enum: ["idle", "planning", "writing", "fixing", "failed"] }).notNull().default("idle"),
    buildNote: text("build_note"),
    // The last test of this version, in plain words (agents/test.ts).
    testResult: jsonb("test_result").$type<TestResult>(),
    // How its build healed itself: what went wrong at each failure, and each
    // repair (agents/diagnosis.ts, agents/fixer.ts).
    heal: jsonb("heal").$type<HealLog>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => ({
    byNumber: uniqueIndex("agent_versions_number_idx").on(t.agentId, t.number),
    oneDraft: uniqueIndex("agent_versions_draft_idx").on(t.agentId).where(sql`${t.state} = 'draft'`),
    knownState: check("agent_versions_state", sql`${t.state} in ('draft', 'published')`),
    publishedHasTime: check("agent_versions_published_at", sql`(${t.state} = 'published') = (${t.publishedAt} is not null)`),
  }),
);

// One owner's running copy of a published agent version: the owner's answers
// to the agent's settings questions, their rule values (text, over the
// maker's defaults), what the agent remembers for them, and its status.
// active runs; paused runs nothing new until resumed; stopped is for good.
// mocks holds what the tools that are still stand-ins answer from (the
// sheets, search results and wallet balance, copied from the version's test
// bench when it is installed). schedule is the owner's time of day ("HH:MM")
// and weekday (0 is Sunday) for a scheduled agent, over the maker's. Only the
// owner ever sees settings, rules, memory or mocks.
export const agentInstallations = pgTable(
  "agent_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["active", "paused", "stopped"] }).notNull().default("active"),
    // Live: its triggers start its jobs. One set up for a test run first
    // isn't live until its owner says: only test runs by hand start it.
    // (A column of its own rather than a status: the deploy's schema push
    // adds columns but doesn't change an existing check constraint.)
    live: boolean("live").notNull().default(true),
    // Why it was paused, when the runtime paused it (a connection it needs
    // went away), in plain words for its owner; null when they paused it.
    pausedReason: text("paused_reason"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    // The Google Sheets tabs its owner gave it, by sheet setting: the only
    // ones its sheet tools reach. The setting's value (what code sees) is
    // the tab's name.
    sheets: jsonb("sheets").$type<Record<string, SheetGrant>>().notNull().default({}),
    rules: jsonb("rules").$type<Record<string, string>>().notNull().default({}),
    memory: jsonb("memory").$type<Record<string, unknown>>().notNull().default({}),
    mocks: jsonb("mocks").$type<Pick<BenchData, "sheets" | "search" | "wallet">>().notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    schedule: jsonb("schedule").$type<{ at: string | null; day: number | null; days?: number[] | null; interval?: number | null }>(),
    minGapMinutes: integer("min_gap_minutes").notNull().default(5),
    dailySpendUsd: numeric("daily_spend_usd", { precision: 10, scale: 4 }).notNull().default("0.5"),
    // What the renter lets it do on its own (agents/risk.ts): tools that
    // always ask first, and how much it may spend per call without asking.
    // Raising only: the platform's floor applies whatever this says.
    policy: jsonb("policy").$type<{ askFor?: string[]; autoSpendUsdc?: number }>().notNull().default({}),
    // The renter's weekly model budget (USDC minor units), within the
    // platform's ceiling; none takes the maker's default.
    modelBudget: numeric("model_budget", { precision: 78, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  },
  (t) => ({
    byOwner: index("agent_installations_owner_idx").on(t.ownerUserId, t.createdAt),
    byAgent: index("agent_installations_agent_idx").on(t.agentId),
    knownStatus: check("agent_installations_status", sql`${t.status} in ('active', 'paused', 'stopped')`),
    gap: check("agent_installations_gap", sql`${t.minGapMinutes} between 0 and 1440`),
  }),
);

// A job: one run of an installation, started by one of its triggers. It
// runs the version it was started on to the end, whatever the installation
// moves to meanwhile. status: queued (waiting to be claimed, at run_after),
// running (claimed_by a worker, which beats heartbeat_at while it runs),
// waiting_for_owner (an approval is open), then done, failed or cancelled.
// state is where the run is (agents/runner.ts RunState): the step, the
// values so far and the current step's journal of tool calls, so a job can
// pick up after a pause or a restart without doing anything twice.
// attempts counts tries after failures outside the agent, each after a
// longer wait. stop_asked: the owner stopped the installation, and the job
// stops after its current step.
export const JOB_STATUSES = ["queued", "running", "waiting_for_owner", "done", "failed", "cancelled"] as const;
export const agentJobs = pgTable(
  "agent_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => agentInstallations.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    // The hold for a rented agent's fee per job, while it runs.
    feeHoldId: uuid("fee_hold_id"),
    // When its model cost was charged to its renter (agents whose renters
    // pay their jobs' model cost); none until then, or never.
    modelSettledAt: timestamp("model_settled_at", { withTimezone: true }),
    // Actions it took (anything that writes, sends or spends), for its limit.
    actions: integer("actions").notNull().default(0),
    // Whether Reppo's sampling took this finished job for a quality score
    // ("sampled"), or passed it by ("skipped", "cap", "budget"); null until
    // the sampler has looked.
    reppoSample: text("reppo_sample"),
    // What started it: { kind: "schedule" | "check" | "message" | "manual" | "test", ... }.
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    // json, not jsonb: kept exactly as written, keys in their order, so a
    // step that runs again sees the very same values.
    state: json("state").$type<RunState>(),
    reason: text("reason"),
    // A done job that wasn't plainly done: "skipped" (a step that judges or
    // writes had nothing to work on, so nothing was sent) or "noted" (a
    // side step didn't go through); null otherwise.
    outcome: text("outcome", { enum: ["skipped", "noted"] }),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).defaultNow().notNull(),
    claimedBy: text("claimed_by"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    stopAsked: boolean("stop_asked").notNull().default(false),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    due: index("agent_jobs_due_idx").on(t.status, t.runAfter),
    byInstallation: index("agent_jobs_installation_idx").on(t.installationId, t.createdAt),
    byOwner: index("agent_jobs_owner_idx").on(t.ownerUserId, t.createdAt),
    // One running job per installation, whoever claims it.
    oneRunning: uniqueIndex("agent_jobs_one_running_idx").on(t.installationId).where(sql`${t.status} = 'running'`),
    // Finished jobs the Reppo sampler hasn't looked at yet.
    toSample: index("agent_jobs_to_sample_idx").on(t.finishedAt).where(sql`${t.reppoSample} is null`),
    knownStatus: check("agent_jobs_status", sql`${t.status} in ('queued', 'running', 'waiting_for_owner', 'done', 'failed', 'cancelled')`),
  }),
);

// Each step a job ran, in order (seq): what went in and came out, its tool
// calls, how long it took, which model decided and what that cost. A step
// that paused for its owner is "waiting" until it runs again and finishes.
// Only the job's owner sees inputs, outputs, tool calls and notes.
export const agentJobSteps = pgTable(
  "agent_job_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => agentJobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    stepId: text("step_id").notNull(),
    status: text("status", { enum: ["running", "ok", "failed", "waiting"] }).notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    tools: jsonb("tools").$type<{ tool: string; args: unknown; result: unknown; error: string | null }[]>().notNull().default([]),
    outcome: text("outcome"),
    note: text("note"),
    model: text("model"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    ms: integer("ms").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    bySeq: uniqueIndex("agent_job_steps_seq_idx").on(t.jobId, t.seq),
  }),
);

// When each of an installation's triggers is due next, by its place in the
// version's triggers. A schedule fires at next_at and moves on; a value
// check runs its check step at next_at and keeps what it found (holds), so
// it starts a job only when the condition turns true. note says why the
// last check failed, in plain words. Messages have no row: they start a job
// when they come.
export const agentTriggers = pgTable(
  "agent_triggers",
  {
    installationId: uuid("installation_id")
      .notNull()
      .references(() => agentInstallations.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    kind: text("kind", { enum: ["schedule", "check"] }).notNull(),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
    holds: boolean("holds"),
    lastAt: timestamp("last_at", { withTimezone: true }),
    note: text("note"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.installationId, t.index] }),
    due: index("agent_triggers_due_idx").on(t.nextAt),
  }),
);

// The in-app message box of an installation (Telegram comes later): what
// its owner sends it, each starting a job with the message as its input,
// and what the agent sends its owner (telegram.send).
export const agentMessages = pgTable(
  "agent_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => agentInstallations.id, { onDelete: "cascade" }),
    from: text("from", { enum: ["owner", "agent"] }).notNull(),
    text: text("text").notNull(),
    jobId: uuid("job_id").references(() => agentJobs.id, { onDelete: "set null" }),
    // A message to the owner, in their Telegram chat too: "pending" until
    // sent, then "sent", "none" (no Telegram linked) or "failed"; "held"
    // while it waits for the owner's yes with the run's other messages
    // (agents/runtime/held.ts), shown nowhere. A message from the owner
    // says "telegram" when it came from there.
    tgState: text("tg_state", { enum: ["pending", "sent", "none", "failed", "telegram", "held"] }),
    tgAttempts: integer("tg_attempts").notNull().default(0),
    // A long message goes to Telegram in numbered parts: how many of them,
    // from the first, were delivered, so a try after a failure sends only
    // the rest.
    tgParts: integer("tg_parts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tgDue: index("agent_messages_tg_idx").on(t.tgState),
    byInstallation: index("agent_messages_installation_idx").on(t.installationId, t.createdAt),
  }),
);

// A question a job waits on: its owner's yes or no to an action over a
// rule's limit, or an answer to the agent's own question (telegram.ask).
// options are the answers they can give, each with what happens then;
// no_answer says what happens if none comes by expires_at (the maker sets
// how long, 24 hours unless they said otherwise). call_index is the tool
// call in the paused step's journal that the answer belongs to.
export const agentApprovals = pgTable(
  "agent_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => agentJobs.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => agentInstallations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    callIndex: integer("call_index").notNull(),
    // ask: the agent's own question; over_limit: spending over a rule's
    // limit; safety: the platform's checks (risk levels, the guard, untrusted
    // input, budgets). Not a checked column, so new kinds need no change a
    // deploy's schema push would skip.
    kind: text("kind", { enum: ["ask", "over_limit", "safety"] }).notNull(),
    question: text("question").notNull(),
    // Why the platform asks, in plain words, when it does.
    reason: text("reason"),
    options: jsonb("options").$type<{ label: string; effect: string }[]>().notNull(),
    noAnswer: text("no_answer").notNull(),
    status: text("status", { enum: ["pending", "answered", "expired", "cancelled"] }).notNull().default("pending"),
    answer: text("answer"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    // The question in the owner's Telegram chat: "pending" until it is
    // sent there (with a button per answer), "sent" while it waits there,
    // "closed" once that message shows how it ended, "none" when the owner
    // has no Telegram linked, "failed" after giving up.
    tgState: text("tg_state", { enum: ["pending", "sent", "closed", "none", "failed"] }),
    tgMessageId: integer("tg_message_id"),
    tgAttempts: integer("tg_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tgDue: index("agent_approvals_tg_idx").on(t.tgState),
    byOwner: index("agent_approvals_owner_idx").on(t.ownerUserId, t.status),
    due: index("agent_approvals_due_idx").on(t.status, t.expiresAt),
    byJob: index("agent_approvals_job_idx").on(t.jobId),
    knownStatus: check("agent_approvals_status", sql`${t.status} in ('pending', 'answered', 'expired', 'cancelled')`),
  }),
);

// What an installation's agent spent (a payment, or order rows with an
// amount), one row per action, for its spending guard: the job's running
// total and the installation's total for the day (in its owner's time
// zone) are sums of these.
export const agentSpend = pgTable(
  "agent_spend",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => agentInstallations.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => agentJobs.id, { onDelete: "set null" }),
    actionId: text("action_id"),
    tool: text("tool").notNull(),
    amountUsdc: numeric("amount_usdc", { precision: 18, scale: 6 }).notNull(),
    day: text("day").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byDay: index("agent_spend_day_idx").on(t.installationId, t.day),
    byJob: index("agent_spend_job_idx").on(t.jobId),
  }),
);

// Calls an installation's agent made to an outside service each day (UTC),
// by tool, for its daily caps (sheets, web search). The site's own total
// per tool is kept under the nil installation id.
export const agentToolDays = pgTable(
  "agent_tool_days",
  {
    installationId: uuid("installation_id").notNull(),
    day: text("day").notNull(),
    tool: text("tool").notNull(),
    calls: integer("calls").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.installationId, t.day, t.tool] }) }),
);

// Pages an installation's agent fetched (web.fetch) each day (UTC), for
// its daily limit.
export const agentFetchDays = pgTable(
  "agent_fetch_days",
  {
    installationId: uuid("installation_id")
      .notNull()
      .references(() => agentInstallations.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    fetches: integer("fetches").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.installationId, t.day] }) }),
);

// What an installation's agent has taken from a source it reads new items
// from (a Typeform form's responses), by the item's own id, so the same
// item never goes through it twice. A job's items are "read" while it
// runs; once the job is done, or has sent, written or paid anything, they
// are "done". A job that did neither lets them go, to be read again.
export const agentSeenItems = pgTable(
  "agent_seen_items",
  {
    installationId: uuid("installation_id")
      .notNull()
      .references(() => agentInstallations.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    itemId: text("item_id").notNull(),
    jobId: uuid("job_id"),
    state: text("state", { enum: ["read", "done"] }).notNull().default("read"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.installationId, t.source, t.itemId] }), byJob: index("agent_seen_items_job_idx").on(t.jobId) }),
);

// The connection vault: each owner's links to outside services, one per
// service. The secret (a Telegram chat, Google tokens) is AES-256-GCM
// ciphertext only (crypto.ts), decrypted on the server for the one call
// that needs it: never readable by agent code, makers, logs or responses.
// label is what the owner sees ("@name", an email address). lookup is a
// keyed hash for finding a Telegram chat's owner without decrypting every
// row; a chat links to one owner at a time.
export const CONNECTION_PROVIDERS = ["telegram", "google", "typeform"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: CONNECTION_PROVIDERS }).notNull(),
    label: text("label").notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    lookup: text("lookup"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => ({
    onePerService: uniqueIndex("connections_owner_provider_idx").on(t.ownerUserId, t.provider),
    byLookup: uniqueIndex("connections_lookup_idx").on(t.provider, t.lookup),
    knownProvider: check("connections_provider", sql`${t.provider} in ('telegram', 'google', 'typeform')`),
  }),
);

// Telegram linking: a one-time code the owner sends the bot (/start CODE)
// from the chat they want linked. Kept as a hash; it works once, within
// ten minutes.
export const telegramLinkCodes = pgTable(
  "telegram_link_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byOwner: index("telegram_link_codes_owner_idx").on(t.ownerUserId, t.createdAt) }),
);

// The webhook's secret, as a hash (one row). scripts/telegram-webhook.ts
// sets a fresh one; the one before keeps working for a few minutes while
// Telegram changes over.
export const telegramWebhook = pgTable(
  "telegram_webhook",
  {
    id: integer("id").primaryKey().default(1),
    secretHash: text("secret_hash").notNull(),
    previousHash: text("previous_hash"),
    setAt: timestamp("set_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ one: check("telegram_webhook_one", sql`${t.id} = 1`) }),
);

// Updates already handled: Telegram sends one again when it isn't sure it
// arrived, and it must not start a second job.
export const telegramUpdates = pgTable("telegram_updates", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

// A message an owner sent the bot while they run several agents that take
// messages: it waits here while they pick which one it is for.
export const telegramPending = pgTable(
  "telegram_pending",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    // The installations offered, in the menu's order.
    installationIds: jsonb("installation_ids").$type<string[]>().notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byOwner: index("telegram_pending_owner_idx").on(t.ownerUserId, t.createdAt) }),
);

// Connecting Google: the state of a sign-in on its way, as a hash, tied to
// the owner who started it. It works once, within ten minutes.
export const googleOAuthStates = pgTable("google_oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  returnTo: text("return_to").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// What people send the bot with /support: kept for the admin page. The
// account when the chat is linked, else the Telegram name they go by.
export const supportMessages = pgTable(
  "support_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    telegramName: text("telegram_name"),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byCreated: index("support_messages_created_idx").on(t.createdAt) }),
);

// An agent on the board for rent: which published version new renters
// get, and its price in USDC minor units (6 decimals) a week, with an
// optional fee per job. 0 is free (the examples, for testing). Unlisted
// agents keep their renters but take no new ones.
export const agentListings = pgTable(
  "agent_listings",
  {
    agentId: uuid("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "cascade" }),
    weeklyPrice: numeric("weekly_price", { precision: 78, scale: 0 }).notNull().default("0"),
    jobFee: numeric("job_fee", { precision: 78, scale: 0 }).notNull().default("0"),
    listed: boolean("listed").notNull().default(true),
    // The maker's default weekly model budget for each renter (USDC minor
    // units; none takes the platform's default), and whether renters pay
    // their jobs' model cost on top of the fee per job.
    modelBudget: numeric("model_budget", { precision: 78, scale: 0 }),
    modelShare: boolean("model_share").notNull().default(false),
    // SERV's screen before it goes public: ok, held for an admin (with why),
    // or hidden by one. The hash of what was screened, to screen it again
    // only when it changes.
    screen: text("screen", { enum: ["ok", "held", "hidden"] }).notNull().default("ok"),
    screenReason: text("screen_reason"),
    screenHash: text("screen_hash"),
    // Reppo's blocks before this don't count toward a hold: set when an
    // admin lets a held listing back on the board.
    qualityClearedAt: timestamp("quality_cleared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byListed: index("agent_listings_listed_idx").on(t.listed, t.weeklyPrice),
    priced: check("agent_listings_prices", sql`${t.weeklyPrice} >= 0 and ${t.jobFee} >= 0`),
  }),
);

// Renting an agent: one renter's weekly rental of a maker's agent, at the
// prices it was rented at (USDC minor units). Each week is charged from
// the renter's balance through the ledger (90% to the maker, 10% to the
// platform), at most once (rental_charges). status: active (paid up),
// unpaid (a week's rent couldn't be paid: its installation is paused),
// ended (cancelled and its last paid week over). renews: false once the
// renter cancels; it runs to the end of the week they paid for.
export const RENTAL_STATUSES = ["active", "unpaid", "ended"] as const;
export const rentals = pgTable(
  "rentals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "cascade" }),
    renterUserId: uuid("renter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    makerUserId: uuid("maker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id").references(() => agentInstallations.id, { onDelete: "set null" }),
    weeklyPrice: numeric("weekly_price", { precision: 78, scale: 0 }).notNull(),
    jobFee: numeric("job_fee", { precision: 78, scale: 0 }).notNull().default("0"),
    // Each job's model cost is charged to the renter on top of its fee.
    modelShare: boolean("model_share").notNull().default(false),
    status: text("status", { enum: RENTAL_STATUSES }).notNull().default("active"),
    renews: boolean("renews").notNull().default(true),
    paidUntil: timestamp("paid_until", { withTimezone: true }).notNull(),
    weeksPaid: integer("weeks_paid").notNull().default(0),
    // A newer version its maker published, waiting for the renter to update or stay.
    offeredVersionId: uuid("offered_version_id").references(() => agentVersions.id, { onDelete: "set null" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byRenter: index("rentals_renter_idx").on(t.renterUserId, t.createdAt),
    byAgent: index("rentals_agent_idx").on(t.agentId),
    due: index("rentals_due_idx").on(t.status, t.paidUntil),
    knownStatus: check("rentals_status", sql`${t.status} in ('active', 'unpaid', 'ended')`),
    priced: check("rentals_prices", sql`${t.weeklyPrice} >= 0 and ${t.jobFee} >= 0`),
  }),
);

// Each week of a rental charged, once: the week's number from the start,
// the amount and the hold it was captured through (none when free).
export const rentalCharges = pgTable(
  "rental_charges",
  {
    rentalId: uuid("rental_id")
      .notNull()
      .references(() => rentals.id, { onDelete: "cascade" }),
    week: integer("week").notNull(),
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    holdId: uuid("hold_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.rentalId, t.week] }) }),
);

// The request board: someone asks for an agent (what it should do, what
// it should connect to, what they'd pay a week), others say "me too", and
// makers offer one of their published agents with a note and a price.
// Accepting an offer rents that agent at the offer's price.
export const REQUEST_STATUSES = ["open", "accepted", "closed"] as const;
export const requests = pgTable(
  "requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    need: text("need").notNull(),
    detail: text("detail").notNull().default(""),
    connects: jsonb("connects").$type<("telegram" | "sheets" | "web")[]>().notNull().default([]),
    // What they'd pay a week, USDC minor units; null when they didn't say.
    budget: numeric("budget", { precision: 78, scale: 0 }),
    status: text("status", { enum: REQUEST_STATUSES }).notNull().default("open"),
    // SERV's screen before it goes public (see agent_listings.screen).
    screen: text("screen", { enum: ["ok", "held", "hidden"] }).notNull().default("ok"),
    screenReason: text("screen_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStatus: index("requests_status_idx").on(t.status, t.createdAt),
    byUser: index("requests_user_idx").on(t.userId),
    knownStatus: check("requests_status", sql`${t.status} in ('open', 'accepted', 'closed')`),
    budgeted: check("requests_budget", sql`${t.budget} is null or ${t.budget} >= 0`),
  }),
);

export const requestVotes = pgTable(
  "request_votes",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.requestId, t.userId] }) }),
);

export const OFFER_STATUSES = ["open", "accepted", "withdrawn"] as const;
export const requestOffers = pgTable(
  "request_offers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    makerUserId: uuid("maker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    note: text("note").notNull().default(""),
    weeklyPrice: numeric("weekly_price", { precision: 78, scale: 0 }).notNull(),
    jobFee: numeric("job_fee", { precision: 78, scale: 0 }).notNull().default("0"),
    status: text("status", { enum: OFFER_STATUSES }).notNull().default("open"),
    screen: text("screen", { enum: ["ok", "held", "hidden"] }).notNull().default("ok"),
    screenReason: text("screen_reason"),
    rentalId: uuid("rental_id").references(() => rentals.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byRequest: index("request_offers_request_idx").on(t.requestId, t.createdAt),
    oncePerAgent: uniqueIndex("request_offers_agent_once").on(t.requestId, t.agentId),
    knownStatus: check("request_offers_status", sql`${t.status} in ('open', 'accepted', 'withdrawn')`),
    priced: check("request_offers_prices", sql`${t.weeklyPrice} >= 0 and ${t.jobFee} >= 0`),
  }),
);

export type Request = typeof requests.$inferSelect;
export type RequestOffer = typeof requestOffers.$inferSelect;

// The prompt guard's verdicts on untrusted text, by the text's hash, so the
// same sheet or page isn't screened again every run. No text is kept, only
// the short excerpt that shows a flag.
export const inputScreens = pgTable("input_screens", {
  hash: text("hash").primaryKey(),
  verdict: text("verdict", { enum: ["clean", "flagged"] }).notNull(),
  excerpt: text("excerpt").notNull().default(""),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Every model call inside an agent run (a decision, the guard's check, the
// input screen), metered per installation, per job and per day, in tokens
// and in USDC minor units at the configured rates. Calls on the renter's
// own SERV key are kept too (own_key) but cost the site nothing.
export const agentModelUsage = pgTable(
  "agent_model_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => agentInstallations.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => agentJobs.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    purpose: text("purpose", { enum: ["decision", "guard", "screen"] }).notNull(),
    provider: text("provider"),
    model: text("model"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cost: numeric("cost", { precision: 78, scale: 0 }).notNull().default("0"),
    ownKey: boolean("own_key").notNull().default(false),
    // The UTC day, for daily totals.
    day: text("day").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byInstallation: index("agent_model_usage_installation_idx").on(t.installationId, t.createdAt),
    byJob: index("agent_model_usage_job_idx").on(t.jobId),
    byDay: index("agent_model_usage_day_idx").on(t.day),
  }),
);

// Model calls boardofserv makes on its own account, outside any
// installation: SERV's code reviews while an agent is built, the review
// before it is published, screening posts and listings, and screening
// outside a run. Metered like an installation's calls (tokens and cost)
// against the platform's own daily budget (PLATFORM_MODEL_BUDGET_USDC);
// they count toward the site's daily limit through reply_usage too.
export const platformModelUsage = pgTable(
  "platform_model_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Not a checked column: a deploy's schema push doesn't change checks.
    purpose: text("purpose").notNull(),
    // Who it was for (the maker building, the person posting).
    userId: uuid("user_id"),
    agentId: uuid("agent_id"),
    provider: text("provider"),
    model: text("model"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cost: numeric("cost", { precision: 78, scale: 0 }).notNull().default("0"),
    ownKey: boolean("own_key").notNull().default(false),
    day: text("day").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byDay: index("platform_model_usage_day_idx").on(t.day),
    byCreated: index("platform_model_usage_created_idx").on(t.createdAt),
  }),
);

// Every try of every model call made through the SERV client (model.ts):
// what it was for, the provider, its status, time and tokens, which try it
// was and whether the answer came back empty. One call's tries share a
// call_id. The admin's model cost view reads its empty answer and retry
// rates from here. Kept without foreign keys, like the usage tables.
export const modelAttempts = pgTable(
  "model_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callId: uuid("call_id").notNull(),
    purpose: text("purpose").notNull(),
    provider: text("provider"),
    // The HTTP status, null when no response came.
    status: integer("status"),
    // ok, empty, unusable, network, timeout, stream or status.
    outcome: text("outcome").notNull(),
    ms: integer("ms").notNull().default(0),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    // 0 for the first try at a provider.
    retry: integer("retry").notNull().default(0),
    empty: boolean("empty").notNull().default(false),
    ownKey: boolean("own_key").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCreated: index("model_attempts_created_idx").on(t.createdAt),
    byCall: index("model_attempts_call_idx").on(t.callId),
  }),
);

// What healing builds learned (agents/lessons.ts): each repair that fixed a
// build, as a short rule, counted each time the same kind of mistake is put
// right the same way. key is the kind and the rule's words, so the same
// lesson counts up. makers holds the ids of the makers whose builds taught
// it (up to 20): a lesson goes into the planner's and Dolphin's prompts
// only once more than one maker's builds needed it. No foreign keys, like
// the usage tables.
export const agentLessons = pgTable(
  "agent_lessons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    rule: text("rule").notNull(),
    // The last time it was learned: what went wrong, and what fixed it.
    wrong: text("wrong").notNull(),
    fix: text("fix").notNull(),
    count: integer("count").notNull().default(1),
    makers: jsonb("makers").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byKey: uniqueIndex("agent_lessons_key_idx").on(t.key),
    byCount: index("agent_lessons_count_idx").on(t.count),
  }),
);

// Listings, requests and offers held because screening got no answer from
// SERV (empty, or none at all, after the call's own tries): the worker
// screens each again a few times, a while apart (safety/screenRetries.ts),
// before it waits for a person in the admin queue. next_at is null once
// that's over. Its own table, not columns, since a deploy's schema push
// only adds.
export const screenRetries = pgTable(
  "screen_retries",
  {
    subject: text("subject", { enum: ["listing", "request", "offer"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    // Who it is screened for (the maker or the poster).
    userId: uuid("user_id").notNull(),
    // Screened again automatically this many times.
    tries: integer("tries").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.subject, t.subjectId] }),
    due: index("screen_retries_next_idx").on(t.nextAt),
  }),
);

export type ScreenRetry = typeof screenRetries.$inferSelect;

// The audit log: every guarded action an installation's agent took or
// tried (anything that writes, sends or spends), with SERV's check and its
// reason, who approved it and what it cost. Append-only: rows are added
// and never changed or removed (agents/audit.ts is the only writer, and a
// test holds every other file to that). No foreign keys, so the log
// outlives what it is about.
export const AUDIT_OUTCOMES = ["ran", "failed", "asked", "declined", "blocked", "stopped"] as const;
export const agentAudit = pgTable(
  "agent_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The order lines were added in: the log reads newest first by it.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    installationId: uuid("installation_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    jobId: uuid("job_id"),
    // The step's title, the tool and its risk level.
    step: text("step").notNull(),
    tool: text("tool").notNull(),
    risk: text("risk").notNull(),
    // The call in words (it can carry the renter's data).
    what: text("what").notNull(),
    outcome: text("outcome", { enum: AUDIT_OUTCOMES }).notNull(),
    // SERV's check: allow, ask, block, or unavailable (it asked instead);
    // none when the renter's earlier yes let it run.
    guard: text("guard", { enum: ["allow", "ask", "block", "unavailable"] }),
    guardReason: text("guard_reason"),
    // Why it asked, stopped, failed or was declined.
    reason: text("reason"),
    // The renter's yes, or their own rules (nothing needed asking).
    approvedBy: text("approved_by", { enum: ["renter", "rules"] }),
    // The model cost of its check, USDC minor units; USDC it spent.
    cost: numeric("cost", { precision: 78, scale: 0 }).notNull().default("0"),
    spent: numeric("spent", { precision: 20, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySeq: uniqueIndex("agent_audit_seq_idx").on(t.seq),
    byInstallation: index("agent_audit_installation_idx").on(t.installationId, t.seq),
    byAgent: index("agent_audit_agent_idx").on(t.agentId, t.seq),
  }),
);
export type AgentAudit = typeof agentAudit.$inferSelect;
export type NewAgentAudit = typeof agentAudit.$inferInsert;

// A spending allowance for each installation (src/lib/spending): what its
// renter set aside for its agent to pay with, in USDC minor units. The money
// stays in the renter's own balance, held (so nothing else spends it and
// it never shows as available), and this row says how much of that hold is
// this installation's: available to spend, and held for a payment in
// flight. An agent only ever spends from its own installation's allowance.
export const allowances = pgTable(
  "allowances",
  {
    installationId: uuid("installation_id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    currency: text("currency", { enum: CURRENCIES }).notNull().default("USDC"),
    available: numeric("available", { precision: 78, scale: 0 }).notNull().default("0"),
    held: numeric("held", { precision: 78, scale: 0 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOwner: index("allowances_owner_idx").on(t.ownerUserId),
    usdcOnly: check("allowances_usdc", sql`${t.currency} = 'USDC'`),
    availableNotNegative: check("allowances_available_not_negative", sql`${t.available} >= 0`),
    heldNotNegative: check("allowances_held_not_negative", sql`${t.held} >= 0`),
  }),
);

// Every change to an allowance, once by its key: a top up and a
// withdrawal (to and from the renter's balance), a hold and its release
// (a payment in flight), and a spend (a payment that went out). Amounts are
// positive; the kind says which way. Append-only.
export const ALLOWANCE_KINDS = ["topup", "withdraw", "hold", "release", "spend"] as const;
export const allowanceEntries = pgTable(
  "allowance_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    kind: text("kind", { enum: ALLOWANCE_KINDS }).notNull(),
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    // What it is about: an agent payment's id, or null for a top up.
    referenceId: text("reference_id"),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    once: uniqueIndex("allowance_entries_key_idx").on(t.key),
    byInstallation: index("allowance_entries_installation_idx").on(t.installationId, t.createdAt),
    knownKind: check("allowance_entries_kind", sql`${t.kind} in ('topup', 'withdraw', 'hold', 'release', 'spend')`),
    positive: check("allowance_entries_amount_positive", sql`${t.amount} > 0`),
  }),
);
export type Allowance = typeof allowances.$inferSelect;

// Who an installation's agent may pay: its renter's saved payees, each a
// label and a Base address (checksummed). An agent pays nobody else. A
// payee is "active" once its renter saved or confirmed it; one an agent
// suggested waits as "suggested" until its renter confirms it on screen.
// Changing a payee's address makes a new payee (the old one "removed"), so
// its first payment asks again. first_paid_at is null until a payment to it
// went out: the first one always asks.
export const payees = pgTable(
  "payees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    label: text("label").notNull(),
    address: text("address").notNull(),
    status: text("status", { enum: ["active", "suggested", "removed"] }).notNull().default("active"),
    suggestedBy: text("suggested_by"),
    firstPaidAt: timestamp("first_paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => ({
    byInstallation: index("payees_installation_idx").on(t.installationId, t.status),
    // installation_id as an expression too: drizzle-kit 0.31 reads every
    // column of an index with an expression as one, and would otherwise drop
    // and recreate these two on every schema push. The index is the same.
    oneLabel: uniqueIndex("payees_label_idx").on(sql`${t.installationId}`, sql`lower(${t.label})`).where(sql`${t.status} <> 'removed'`),
    oneAddress: uniqueIndex("payees_address_idx").on(sql`${t.installationId}`, sql`lower(${t.address})`).where(sql`${t.status} <> 'removed'`),
    knownStatus: check("payees_status", sql`${t.status} in ('active', 'suggested', 'removed')`),
  }),
);
export type Payee = typeof payees.$inferSelect;

// An agent's payment from its installation's allowance to a saved payee:
// USDC sent from the treasury on Base Sepolia. One row per action, by its
// key (the job and the call), so an action can never send twice, after a
// crash or a restart included. held (the allowance holds it), broadcast
// (signed, its nonce, hash and bytes recorded before it was sent; a resend
// is the same bytes), confirmed (mined and confirmed: the allowance spent,
// the renter's ledger charged), failed (reverted, stuck or refused: the
// hold released, nothing spent). The guard's verdict and the approval are
// kept for its receipt.
export const AGENT_PAYMENT_STATUSES = ["held", "broadcast", "confirmed", "failed"] as const;
export const agentPayments = pgTable(
  "agent_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    installationId: uuid("installation_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    versionId: uuid("version_id").notNull(),
    jobId: uuid("job_id"),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    payeeId: uuid("payee_id").notNull(),
    payeeLabel: text("payee_label").notNull(),
    toAddress: text("to_address").notNull(),
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    currency: text("currency", { enum: CURRENCIES }).notNull().default("USDC"),
    chainId: integer("chain_id").notNull(),
    memo: text("memo"),
    status: text("status", { enum: AGENT_PAYMENT_STATUSES }).notNull().default("held"),
    fromAddress: text("from_address"),
    nonce: integer("nonce"),
    txHash: text("tx_hash"),
    rawTx: text("raw_tx"),
    sends: integer("sends").notNull().default(0),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }),
    guard: text("guard"),
    guardReason: text("guard_reason"),
    approvalId: uuid("approval_id"),
    approvedBy: text("approved_by", { enum: ["renter", "rules"] }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    broadcastAt: timestamp("broadcast_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    // Matched with its transfer on chain and its ledger entries.
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    once: uniqueIndex("agent_payments_key_idx").on(t.key),
    // One agent payment in flight from the treasury at a time on a chain
    // (and, by the treasury's lock, none while a withdrawal is).
    oneInFlight: uniqueIndex("agent_payments_one_in_flight").on(t.chainId).where(sql`${t.status} = 'broadcast'`),
    byInstallation: index("agent_payments_installation_idx").on(t.installationId, t.createdAt),
    byAgent: index("agent_payments_agent_idx").on(t.agentId, t.createdAt),
    byStatus: index("agent_payments_status_idx").on(t.status, t.updatedAt),
    byTx: index("agent_payments_tx_idx").on(t.txHash),
    knownStatus: check("agent_payments_status", sql`${t.status} in ('held', 'broadcast', 'confirmed', 'failed')`),
    positive: check("agent_payments_amount_positive", sql`${t.amount} > 0`),
  }),
);
export type AgentPayment = typeof agentPayments.$inferSelect;

// Trust scores (src/lib/trust): one row per agent version and per maker,
// the latest, with the factors that explain it; and one a day for each, so
// its trend shows. A fixed formula, recomputed after jobs and daily.
export const trustScores = pgTable(
  "trust_scores",
  {
    subject: text("subject", { enum: ["version", "maker"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    score: integer("score").notNull(),
    label: text("label").notNull(),
    isNew: boolean("is_new").notNull(),
    factors: jsonb("factors").$type<{ key: string; words: string; points: number; counted: boolean }[]>().notNull().default([]),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.subject, t.subjectId] }),
    knownSubject: check("trust_scores_subject", sql`${t.subject} in ('version', 'maker')`),
    inRange: check("trust_scores_range", sql`${t.score} between 300 and 850`),
  }),
);
export const trustHistory = pgTable(
  "trust_history",
  {
    subject: text("subject").notNull(),
    subjectId: uuid("subject_id").notNull(),
    day: text("day").notNull(),
    score: integer("score").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.subject, t.subjectId, t.day] }) }),
);

// A renter's dispute of an agent payment or a week's rent, with a reason,
// within the dispute window, for an admin to uphold or reject. An upheld
// rent dispute is refunded through the ledger (the maker's and platform's
// shares reversed); an upheld payment dispute counts against the agent's
// trust score, since a payment on chain can't be pulled back.
export const DISPUTE_KINDS = ["payment", "rent"] as const;
// The reasons, with their words, are in spending/disputeWords.ts (read on screen too).
export { DISPUTE_REASONS };
export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind", { enum: DISPUTE_KINDS }).notNull(),
    renterUserId: uuid("renter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    makerUserId: uuid("maker_user_id")
      .notNull()
      .references(() => users.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    versionId: uuid("version_id"),
    installationId: uuid("installation_id").references(() => agentInstallations.id, { onDelete: "set null" }),
    // What is disputed: one agent payment, or one week's rent charge.
    paymentId: uuid("payment_id").references(() => agentPayments.id),
    rentalId: uuid("rental_id").references(() => rentals.id, { onDelete: "set null" }),
    week: integer("week"),
    holdId: uuid("hold_id"),
    // USDC minor units.
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    reason: text("reason", { enum: DISPUTE_REASONS }).notNull(),
    note: text("note").notNull(),
    status: text("status", { enum: ["open", "upheld", "rejected"] }).notNull().default("open"),
    resolution: text("resolution"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // An upheld rent dispute's refund: waiting (for the ledger's new kinds)
    // or done, with what the maker gave back and what the platform covered.
    refund: text("refund", { enum: ["none", "waiting", "done"] }).notNull().default("none"),
    makerReversed: numeric("maker_reversed", { precision: 78, scale: 0 }),
    platformReversed: numeric("platform_reversed", { precision: 78, scale: 0 }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStatus: index("disputes_status_idx").on(t.status, t.createdAt),
    byRenter: index("disputes_renter_idx").on(t.renterUserId, t.createdAt),
    byAgent: index("disputes_agent_idx").on(t.agentId, t.status),
    oncePayment: uniqueIndex("disputes_once_payment").on(t.paymentId).where(sql`${t.paymentId} is not null`),
    onceWeek: uniqueIndex("disputes_once_week").on(t.rentalId, t.week).where(sql`${t.rentalId} is not null`),
    knownKind: check("disputes_kind", sql`${t.kind} in ('payment', 'rent')`),
    knownReason: check("disputes_reason", sql`${t.reason} in ('not_done', 'not_wanted', 'wrong_amount', 'wrong_payee', 'not_working', 'other')`),
    knownStatus: check("disputes_status", sql`${t.status} in ('open', 'upheld', 'rejected')`),
    knownRefund: check("disputes_refund", sql`${t.refund} in ('none', 'waiting', 'done')`),
    positive: check("disputes_amount_positive", sql`${t.amount} > 0`),
    // A payment dispute names its payment; a rent dispute its week.
    whatItIs: check("disputes_what", sql`(${t.kind} = 'payment' and ${t.paymentId} is not null and ${t.week} is null) or (${t.kind} = 'rent' and ${t.paymentId} is null and ${t.week} is not null)`),
  }),
);
export type Dispute = typeof disputes.$inferSelect;

// Alerts about agent payments for the admin: the treasury running low, a
// payment and its transfer not matching, a transfer from the treasury
// nobody asked for. An open alert of a pausing kind keeps agent payments
// paused site wide until an admin resolves it.
export const paymentAlerts = pgTable(
  "payment_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    // One open alert per thing it is about.
    key: text("key").notNull(),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    resolution: text("resolution"),
  },
  (t) => ({
    once: uniqueIndex("payment_alerts_key_idx").on(t.key),
    byStatus: index("payment_alerts_status_idx").on(t.status, t.createdAt),
    knownStatus: check("payment_alerts_status", sql`${t.status} in ('open', 'resolved')`),
  }),
);

// Reppo's evaluations (src/lib/reppo): a finished job's quality, or a
// second opinion on an action waiting for its renter. One row per thing,
// by its key ("job:<id>", "action:<approval id>"), so nothing is scored
// twice. The input is exactly what was sent: redacted, never renter data.
// Queued here first; the worker submits it within the credit budget, reads
// it back, and records the result. No foreign keys: it outlives the job.
export const reppoEvals = pgTable(
  "reppo_evals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind", { enum: ["job", "action"] }).notNull(),
    key: text("key").notNull(),
    agentId: uuid("agent_id").notNull(),
    versionId: uuid("version_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    jobId: uuid("job_id"),
    approvalId: uuid("approval_id"),
    taskType: text("task_type", { enum: ["claim", "response", "action"] }).notNull(),
    input: text("input").notNull(),
    // queued (to submit), submitted (to read back), completed, failed.
    status: text("status", { enum: ["queued", "submitted", "completed", "failed"] }).notNull().default("queued"),
    reppoId: text("reppo_id"),
    attempts: integer("attempts").notNull().default(0),
    polls: integer("polls").notNull().default(0),
    // When to submit it, or read it back, next.
    nextAt: timestamp("next_at", { withTimezone: true }).defaultNow().notNull(),
    lastError: text("last_error"),
    score: integer("score"),
    route: text("route", { enum: ["ship", "review", "block"] }),
    decision: text("decision"),
    confidence: text("confidence"),
    reason: text("reason"),
    rubric: jsonb("rubric").$type<Record<string, number>>(),
    creditsCharged: integer("credits_charged").notNull().default(0),
    // A job Reppo routed to block waits in the admin queue until an admin
    // looks: when, who, and what they decided.
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    resolution: text("resolution"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    once: uniqueIndex("reppo_evals_key_idx").on(t.key),
    due: index("reppo_evals_due_idx").on(t.status, t.nextAt),
    byVersion: index("reppo_evals_version_idx").on(t.versionId, t.completedAt),
    byAgent: index("reppo_evals_agent_idx").on(t.agentId, t.createdAt),
    bySubmitted: index("reppo_evals_submitted_idx").on(t.submittedAt),
  }),
);
export type ReppoEval = typeof reppoEvals.$inferSelect;

// An admin's freeze of an agent, a version, a maker or a renter, with a
// reason. A frozen thing can't run, be rented, publish or offer. Lifting
// one keeps the row (lifted_at and why): together they are the admin log.
export const FREEZE_KINDS = ["agent", "version", "maker", "renter"] as const;
export const freezes = pgTable(
  "freezes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind", { enum: FREEZE_KINDS }).notNull(),
    targetId: uuid("target_id").notNull(),
    reason: text("reason").notNull(),
    byUserId: uuid("by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedBy: uuid("lifted_by").references(() => users.id),
    liftReason: text("lift_reason"),
  },
  (t) => ({
    active: index("freezes_target_idx").on(t.kind, t.targetId, t.liftedAt),
    knownKind: check("freezes_kind", sql`${t.kind} in ('agent', 'version', 'maker', 'renter')`),
  }),
);
export type Freeze = typeof freezes.$inferSelect;

// Reports from people: an agent, a maker, a request or an offer, with a
// reason from the list and a note. One open report per person per thing.
export const REPORT_KINDS = ["agent", "maker", "request", "offer"] as const;
export const REPORT_REASONS = ["scam", "harmful", "personal_data", "spam", "misleading", "other"] as const;
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind", { enum: REPORT_KINDS }).notNull(),
    targetId: uuid("target_id").notNull(),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: REPORT_REASONS }).notNull(),
    note: text("note").notNull().default(""),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    // What an admin did: approved (nothing wrong), hid it, or froze it.
    resolution: text("resolution"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStatus: index("reports_status_idx").on(t.status, t.createdAt),
    once: uniqueIndex("reports_once").on(t.kind, t.targetId, t.reporterUserId),
    knownKind: check("reports_kind", sql`${t.kind} in ('agent', 'maker', 'request', 'offer')`),
    knownReason: check("reports_reason", sql`${t.reason} in ('scam', 'harmful', 'personal_data', 'spam', 'misleading', 'other')`),
    knownStatus: check("reports_status", sql`${t.status} in ('open', 'resolved')`),
  }),
);
export type Report = typeof reports.$inferSelect;

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentSketchRow = typeof agentSketches.$inferSelect;
export type PublishedHelper = typeof publishedHelpers.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type AgentInstallation = typeof agentInstallations.$inferSelect;
export type AgentJob = typeof agentJobs.$inferSelect;
export type AgentJobStep = typeof agentJobSteps.$inferSelect;
export type AgentTrigger = typeof agentTriggers.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type AgentApproval = typeof agentApprovals.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type AgentListing = typeof agentListings.$inferSelect;
export type Rental = typeof rentals.$inferSelect;
