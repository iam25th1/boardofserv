import type { SketchFieldKey } from "./sketchFields";
import type { AgentDefinition } from "./agents/definition";
import type { BenchData, CodeStatus } from "./agents/types";
// Shapes the browser works with. Dates arrive as ISO strings over JSON.
export interface ConversationDTO {
  id: string;
  title: string;
  // The agent sketch's name, once the conversation has one.
  sketchName: string | null;
  // The slug of the helper published from it, while it is on the board.
  publishedSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  source: string | null;
  sourceLabel: string | null;
  createdAt: string;
}

export interface AccountDTO {
  // Only ever sent to its owner.
  email: string | null;
  // The public name, without the @. Not chosen yet: still the random one.
  handle: string;
  handleChosen: boolean;
  walletAddress: string | null;
  openservUserId: string | null;
  linked: boolean;
  balance: "ok" | "low" | "unknown";
  // Named in ADMIN_USER_IDS: the account menu links to /admin.
  admin?: boolean;
  // Whether the account is let in: anything but "approved" sees the waitlist.
  access?: "approved" | "waiting" | "rejected";
  // The user's own SERV key, as its last four characters, or null.
  servKey?: { last4: string } | null;
  // Messages left today, or null when there is no daily limit.
  chat?: QuotaDTO | null;
  // The day's spend limit is reached: chat and helper uses wait for midnight UTC.
  paused?: boolean;
}

// The agent sketch for one conversation, as the server stores and sends it.
// An agent is described by watches, when, how and tells; an answer helper by
// takes, does and gives (see sketchFields.ts).
export interface SketchDTO {
  name: string | null;
  kind: "watcher" | "digest" | "helper" | "answer" | "agent" | null;
  watches: string | null;
  when: string | null;
  how: string | null;
  tells: string | null;
  takes: string | null;
  does: string | null;
  gives: string | null;
  // An agent's interview: what wakes it up, where it looks, what it does with
  // what it finds, what counts as done, what it must never do without
  // asking, what the owner sets up and what it should remember.
  wakes?: string | null;
  looks?: string | null;
  handles?: string | null;
  finish?: string | null;
  asks?: string | null;
  setup?: string | null;
  remembers?: string | null;
  // The one field the latest reply asks about.
  asking: SketchFieldKey | null;
  live: boolean;
  // The maker picked the kind on the dock: the plan no longer changes it.
  kindChosen?: boolean;
}

// An agent built from a conversation, as its maker's dock shows it: the
// steps' shape and how far the build has got, never code or prompts.
export interface AgentSummaryDTO {
  id: string;
  version: number;
  state: "draft" | "published";
  buildState: "idle" | "planning" | "writing" | "fixing" | "failed";
  buildNote: string | null;
  // Empty until the first plan is made.
  steps: {
    id: string;
    title: string;
    kind: "code" | "decision" | "action";
    next: (string | null)[];
    // A code step's code: null for other kinds.
    code: "queued" | "writing" | "reviewing" | "approved" | "needs_attention" | null;
  }[];
}

// Everything the agent's own builder shows its maker: the definition, each
// code step's code and review, the test bench's sample data and the
// versions. Only ever sent to the agent's maker.
export interface AgentBuilderDTO {
  agent: AgentSummaryDTO;
  name: string;
  conversationId: string | null;
  definition: AgentDefinition | null;
  code: Record<string, { status: CodeStatus; source: string | null; rounds: number; note: string | null }>;
  bench: BenchData;
  versions: { number: number; state: "draft" | "published"; createdAt: string; publishedAt: string | null }[];
  // The newest published version, which "Run it for real" installs: its
  // definition (for the settings form) and the bench's sample settings to
  // start the answers from. Null before the first is published.
  runnable: { version: number; definition: AgentDefinition; defaults: Record<string, unknown> } | null;
}

// One of the maker's agents on their own agents page.
export interface AgentListItemDTO {
  id: string;
  name: string;
  version: number;
  // The newest published version, in testing; null before the first.
  testing: number | null;
  draft: boolean;
  steps: number;
  updatedAt: string;
}

// One owner's running copy of an agent, as its owner sees it. Only ever
// sent to that owner.
export interface InstallationDTO {
  id: string;
  agentId: string;
  name: string;
  version: number;
  status: "active" | "paused" | "stopped";
  timezone: string;
  settings: { key: string; label: string; value: unknown }[];
  rules: { key: string; label: string; type: string; value: string }[];
  minGapMinutes: number;
  dailySpendUsd: number;
  createdAt: string;
}

// A published helper as anyone may see it: never its instructions.
export interface PublicHelperDTO {
  slug: string;
  name: string;
  description: string;
  inputHint: string;
  // The maker's handle, without the @. Never anything from their email.
  maker: string;
  createdAt: string;
  // The price of one use in each currency the maker accepts (minor units).
  // Empty: free to try, with the daily limit.
  prices: PriceDTO[];
}

export interface PriceDTO {
  currency: "USDC" | "SERV";
  amount: string;
  decimals: number;
}

// A signed-in user's uses of published helpers (or chat messages) today.
// They run on the operator's key, so each user has a daily limit.
export interface QuotaDTO {
  limit: number;
  remaining: number;
  // When the count starts again (midnight UTC), as an ISO string.
  resetsAt: string;
}

// Payments as the browser sees them. Every amount is a whole number of the
// currency's minor units, as a string of digits (see money.ts).
export interface CurrencyDTO {
  code: "USDC" | "SERV";
  decimals: number;
  token: string;
  // The smallest withdrawal, or null while withdrawals of it are closed.
  withdrawMin: string | null;
}

export interface PaymentsDTO {
  enabled: boolean;
  network: "base-sepolia" | "base";
  networkLabel: string;
  chainId: number;
  mainnet: boolean;
  // The block explorer for the network, for transaction links.
  explorer: string;
  // Where deposits go. Public.
  treasury: string | null;
  confirmations: number;
  currencies: CurrencyDTO[];
}

export interface BalanceDTO {
  currency: "USDC" | "SERV";
  available: string;
  // Set aside for uses still running.
  held: string;
}

export interface LinkedWalletDTO {
  address: string;
  embedded: boolean;
}

export interface DepositDTO {
  id: string;
  currency: "USDC" | "SERV";
  amount: string;
  txHash: string;
  status: "confirming" | "credited" | "dropped";
  seenAt: string;
}

export interface WithdrawalDTO {
  id: string;
  currency: "USDC" | "SERV";
  amount: string;
  to: string;
  status: "awaiting_approval" | "queued" | "broadcast" | "paid" | "reverted" | "rejected" | "failed";
  // Why it waits for approval.
  reason: string | null;
  txHash: string | null;
  createdAt: string;
}

// The admin page. Users appear by handle only.
export interface AdminWithdrawalDTO extends WithdrawalDTO {
  maker: string;
  auto: boolean;
  nonce: number | null;
  // Never mined and its nonce went to another transaction: it can be marked
  // failed, which gives the amount back.
  stuck: boolean;
}

export interface AdminDTO {
  // Invite-only mode, and the accounts waiting to get in, oldest first. The
  // one place an email is shown to anyone but its owner: an admin needs it
  // to know who is asking.
  access: { inviteOnly: boolean; waiting: { id: string; handle: string; email: string | null; joinedAt: string }[] };
  // Today's estimated model spend on the operator's keys against the daily
  // limit, in US dollars, and when the day ends (midnight UTC).
  spend: { today: number; limit: number; resetsAt: string };
  network: "base-sepolia" | "base";
  networkLabel: string;
  chainId: number;
  explorer: string;
  treasury: string | null;
  paused: boolean;
  // Why payouts can't be signed, or null when they can.
  signer: string | null;
  currencies: {
    code: "USDC" | "SERV";
    decimals: number;
    // On chain; null when it could not be read.
    treasury: string | null;
    // Balances plus withdrawals not yet paid out.
    owed: string;
    // treasury minus owed. Must never be below zero.
    difference: string | null;
    // The platform's 10% of paid uses, all time.
    fees: string;
    problem: string | null;
  }[];
  approvals: AdminWithdrawalDTO[];
  history: AdminWithdrawalDTO[];
  unmatched: { id: string; currency: "USDC" | "SERV"; amount: string; from: string; txHash: string; seenAt: string }[];
}

// The signed-in user's own money: never anyone else's.
export interface WalletDTO {
  balances: BalanceDTO[];
  // All a maker has earned from their helpers, per currency.
  earned: { currency: "USDC" | "SERV"; amount: string }[];
  wallets: LinkedWalletDTO[];
  deposits: DepositDTO[];
  withdrawals: WithdrawalDTO[];
}

// One use of a helper, as the server streams it. A free use reports the
// uses left today; a paid one, the balance it was paid from.
export type HelperEvent =
  | { type: "meta"; source: string; label: string }
  | { type: "delta"; text: string }
  // The answer was stopped for carrying the helper's instructions.
  | { type: "blocked"; message: string; quota?: QuotaDTO; balance?: BalanceDTO }
  | { type: "done"; quota?: QuotaDTO; balance?: BalanceDTO }
  // `prices` when the price changed since the page loaded.
  | { type: "error"; message: string; quota?: QuotaDTO; balance?: BalanceDTO; prices?: PriceDTO[] };

export type ChatEvent =
  // The plan's sketch, sent before the reply starts. It names the
  // conversation because it arrives before meta.
  | { type: "sketch"; conversationId: string; sketch: SketchDTO }
  | { type: "meta"; conversationId: string; source: string; label: string }
  | { type: "delta"; text: string }
  // The reply is finished and saved, with the plan's answers to show under it
  // as buttons (none when the plan failed); done follows.
  | { type: "reply_end"; messageId?: string; source: string; label: string; choices: string[] }
  | { type: "done"; messageId?: string; source: string; label: string }
  // `limit` when a day's limit refused the turn before anything was stored.
  | { type: "error"; message: string; limit?: "site" | "chat" };
