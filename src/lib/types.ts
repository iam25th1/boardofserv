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
}

// The agent sketch for one conversation, as the server stores and sends it.
// An agent is described by watches, when, how and tells; an answer helper by
// takes, does and gives (see sketchFields.ts).
export interface SketchDTO {
  name: string | null;
  kind: "watcher" | "digest" | "helper" | "answer" | null;
  watches: string | null;
  when: string | null;
  how: string | null;
  tells: string | null;
  takes: string | null;
  does: string | null;
  gives: string | null;
  // The one field the latest reply asks about.
  asking: "watches" | "when" | "how" | "tells" | "takes" | "does" | "gives" | null;
  live: boolean;
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

// A signed-in user's uses of published helpers today. Uses run on the
// operator's key until payments exist, so each user has a daily limit.
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
  | { type: "error"; message: string; quota?: QuotaDTO; balance?: BalanceDTO };

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
  | { type: "error"; message: string };
