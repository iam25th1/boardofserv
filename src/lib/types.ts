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
  // writer: who wrote it (SERV when Dolphin failed twice on the step).
  code: Record<string, { status: CodeStatus; source: string | null; rounds: number; note: string | null; writer?: "dolphin" | "serv" }>;
  bench: BenchData;
  versions: { number: number; state: "draft" | "published"; createdAt: string; publishedAt: string | null }[];
  // The newest published version, which "Run it for real" installs: its
  // definition (for the settings form) and the bench's sample settings to
  // start the answers from. Null before the first is published.
  runnable: { version: number; definition: AgentDefinition; defaults: Record<string, unknown> } | null;
  // Its place on the board for rent, once its maker put it there.
  listing: MakerListingDTO | null;
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
  // On the board for rent, and how many rent it now; null when it isn't.
  board: { renters: number } | null;
}

// One owner's running copy of an agent, as its owner sees it. Only ever
// sent to that owner.
export interface InstallationDTO {
  id: string;
  agentId: string;
  name: string;
  version: number;
  // testing: set up, not live yet (test runs only, by hand).
  status: "testing" | "active" | "paused" | "stopped";
  // Why the runtime paused it (a connection it needs went away), or null.
  pausedReason: string | null;
  // The connections it needs, and which of those the owner hasn't made.
  needs: { telegram: boolean; google: boolean };
  missing: ("telegram" | "google")[];
  timezone: string;
  // A sheet setting also says which spreadsheet and tab it was given.
  settings: { key: string; label: string; value: unknown; sheet?: { title: string; tab: string; link: string } }[];
  rules: { key: string; label: string; type: string; value: string }[];
  minGapMinutes: number;
  dailySpendUsd: number;
  createdAt: string;
  // When it runs, in plain words ("Runs every day at 7:00"), and the next
  // time it is due (null while it isn't active, or for messages only).
  runs: string[];
  nextRunAt: string | null;
  takesMessages: boolean;
  // Why its last value check failed, if it did.
  checkNote: string | null;
  // What the agent remembers for this owner (theirs alone).
  memory: { key: string; description: string; value: unknown }[];
  spendTodayUsd: number;
  recentJobs: JobSummaryDTO[];
  // The questions its jobs wait on.
  approvals: ApprovalDTO[];
  // What it may do on its own, and what asks first.
  safety: SafetyDTO;
}

// An installation's tools by risk level (read, write, outbound, money), and
// what its renter lets it do without asking.
export interface SafetyDTO {
  tools: {
    tool: string;
    risk: "read" | "write" | "outbound" | "money";
    // What it does, in plain words.
    does: string;
    // What the platform always does about it, whatever the renter says.
    floor: string | null;
    // The renter asked to approve it every time.
    asks: boolean;
    // The renter can raise it to "ask me first".
    canRaise: boolean;
  }[];
  autoSpendUsdc: number;
  maxAutoSpendUsdc: number;
}

// An agent on the board, for anyone: what it does, what it connects to,
// its price (USDC minor units, with the decimals) and who made it. Never
// its code, its prompts or anyone's data. Quality and trust scores come
// later: null until then ("not enough reviewed jobs yet").
export interface AgentListingDTO {
  id: string;
  name: string;
  does: string;
  connects: ("telegram" | "sheets" | "web")[];
  weeklyPrice: string;
  jobFee: string;
  decimals: number;
  renters: number;
  maker: string;
  version: number;
  quality: number | null;
  trust: number | null;
  createdAt: string;
}

// An agent's own page: the listing, and the plan in plain words. Steps are
// titles (and a decision's outcomes), never code or prompts.
export interface AgentPageDTO extends AgentListingDTO {
  done: string;
  runs: string[];
  steps: { kind: "works" | "decides" | "acts"; title: string; outcomes: string[] }[];
  // What the renter answers at setup.
  asks: { label: string; help: string; kind: string }[];
  needs: { telegram: boolean; google: boolean };
  // What it never does without the renter's yes, and all it may ever do.
  neverWithoutAsking: string[];
  canOnly: string[];
  // The viewer made it (they run it from their builder, not by renting).
  mine: boolean;
  // The viewer's rental of it, while it lasts.
  rentalId: string | null;
}

// An agent its maker has put on the board for rent: the price (USDC minor
// units), and the published version renters get.
export interface MakerListingDTO {
  weeklyPrice: string;
  jobFee: string;
  decimals: number;
  listed: boolean;
  version: number;
}

// One of the renter's rentals, as only they see it. status: "setup" until
// they set it up, "testing" until they make it live, then "active" or
// "paused"; "unpaid" when a week's rent couldn't be paid (paused until
// they top up and resume); "cancelling" when it stops at paidUntil;
// "ended" after.
export interface RentalDTO {
  id: string;
  agentId: string;
  name: string;
  does: string;
  maker: string;
  version: number;
  status: "setup" | "testing" | "active" | "paused" | "unpaid" | "cancelling" | "ended";
  pausedReason: string | null;
  weeklyPrice: string;
  jobFee: string;
  decimals: number;
  paidUntil: string;
  renews: boolean;
  weeksPaid: number;
  installationId: string | null;
  createdAt: string;
  // When it runs next (live and not paused), and how many of its questions
  // wait for the renter's answer.
  nextRunAt: string | null;
  waiting: number;
  // A newer version its maker published, waiting for the renter to update
  // to it or stay; breaking says why updating needs setting up again.
  offer: { version: number; breaking: string | null } | null;
}

// One rental on its own page: the rental, its money (USDC minor units) and
// how its installation is doing (null until it is set up).
export interface RentalDetailDTO extends RentalDTO {
  money: {
    // Every week charged and every fee per job taken, since it started.
    spentSoFar: string;
    // This week's rent and the fees taken since it began.
    thisWeek: string;
    // Fees set aside for jobs running now.
    feesHeld: string;
  };
  installation: InstallationDTO | null;
}

// One of the owner's connections, as only they see it: the service, the
// account or chat it is linked to, when, and what uses it. Never a secret.
export interface ConnectionDTO {
  provider: "telegram" | "google";
  name: string;
  label: string;
  connectedAt: string;
  lastUsedAt: string | null;
  usedBy: { id: string; name: string; status: string }[];
}

// A job, in a list: how it started and ended, its time and cost. reason
// (which can quote the owner's data) is the owner's alone.
export interface JobSummaryDTO {
  id: string;
  installationId: string;
  agentName: string;
  status: "queued" | "running" | "waiting_for_owner" | "done" | "failed" | "cancelled";
  reason: string | null;
  // In words: "on its schedule", "by your message".
  started: string;
  // What started it: schedule, check, message, manual or test.
  trigger: string;
  createdAt: string;
  finishedAt: string | null;
  costUsd: number;
  ms: number;
  stepCount: number;
  // The viewer's own installation's job.
  mine: boolean;
}

// One step a job ran. The owner gets everything; the maker of someone
// else's installation only which step, how it went, its time, model, cost
// and which tools it called.
export interface JobStepDTO {
  seq: number;
  stepId: string;
  title: string;
  kind: "code" | "decision" | "action";
  status: "running" | "ok" | "failed" | "waiting";
  ms: number;
  model: string | null;
  costUsd: number;
  tools: { tool: string; failed: boolean }[];
  input?: unknown;
  output?: unknown;
  outcome?: string | null;
  note?: string | null;
  calls?: { tool: string; args: unknown; result: unknown; error: string | null }[];
}

export interface JobDTO extends JobSummaryDTO {
  viewer: "owner" | "maker";
  version: number;
  // Which values came from web pages (the owner's view).
  untrusted: string[];
  steps: JobStepDTO[];
  // The agent's steps, for the timeline's names.
  plan: { id: string; title: string; kind: "code" | "decision" | "action" }[];
  approvals: ApprovalDTO[];
}

// A question a job waits on, as its owner sees it: what it asks, the
// answers they can give and what happens on each, and with none.
export interface ApprovalDTO {
  id: string;
  jobId: string;
  installationId: string;
  agentName: string;
  stepTitle: string;
  kind: "ask" | "over_limit" | "safety";
  question: string;
  // Why the platform asks (a safety check), shown beside the question.
  reason: string | null;
  options: { label: string; effect: string }[];
  noAnswer: string;
  status: "pending" | "answered" | "expired" | "cancelled";
  answer: string | null;
  expiresAt: string;
  createdAt: string;
}

// A message in an installation's in-app message box.
export interface AgentMessageDTO {
  id: string;
  from: "owner" | "agent";
  text: string;
  jobId: string | null;
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
  // How often SERV wrote a code step because Dolphin failed twice on it:
  // in the last 30 days, and in all.
  codeFallbacks: { last30Days: number; total: number };
  // What people sent the bot with /support, newest first: who (a handle,
  // or the Telegram name of an unlinked chat) and what.
  support: { id: string; from: string; text: string; at: string }[];
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

// A maker's view of their agent on the board: who rents it (by handle),
// what it earned them each week (their 90%, USDC minor units), how its
// renters' jobs went in the last 30 days and where failing ones failed (by
// step: never the renter's data), and each published version with how
// many run it.
export interface MakerDashboardDTO {
  agentId: string;
  name: string;
  listing: MakerListingDTO | null;
  decimals: number;
  renters: { handle: string; since: string; status: RentalDTO["status"]; version: number; weeksPaid: number }[];
  // The last eight weeks, oldest first, each starting on a Monday.
  earnings: { week: string; amount: string }[];
  earnedTotal: string;
  jobs: { done: number; failed: number };
  failures: { step: string; count: number }[];
  versions: { number: number; publishedAt: string | null; renters: number; offered: number }[];
}

// A request on the request board, for anyone: what someone wants an agent
// for, what it should connect to and what they'd pay a week (USDC minor
// units, or null), how many said "me too" and how many offers it has.
export interface RequestDTO {
  id: string;
  need: string;
  detail: string;
  connects: ("telegram" | "sheets" | "web")[];
  budget: string | null;
  decimals: number;
  by: string;
  status: "open" | "accepted" | "closed";
  meToo: number;
  offers: number;
  createdAt: string;
  // The viewer's own request, and whether they said "me too".
  mine: boolean;
  votedByMe: boolean;
}

// A maker's offer on a request: one of their published agents, as the
// board shows it, with a note and the price they offer it at.
export interface OfferDTO {
  id: string;
  agent: { id: string; name: string; does: string; connects: ("telegram" | "sheets" | "web")[]; version: number; listed: boolean };
  maker: string;
  note: string;
  weeklyPrice: string;
  jobFee: string;
  decimals: number;
  status: "open" | "accepted" | "withdrawn";
  createdAt: string;
  // The viewer made this offer.
  mine: boolean;
}

// A request on its own page, with its offers (withdrawn ones left out).
export interface RequestPageDTO {
  request: RequestDTO;
  offers: OfferDTO[];
}
