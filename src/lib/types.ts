import type { MoneyKind } from "./moneyWords";
import type { SketchFieldKey } from "./sketchFields";
import type { AgentDefinition, StepKind } from "./agents/definition";
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
  // The agent page opens with everything shown (step graph, code, test
  // bench, versions), not the plain view.
  agentDetails?: boolean;
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
    kind: StepKind;
    next: (string | null)[];
    // A code step's code: null for other kinds.
    code: "queued" | "writing" | "reviewing" | "approved" | "needs_attention" | null;
  }[];
  // The last test, as its story; and what is wrong now, in one sentence,
  // with how "Fix this" fixes it (agents/plainWords.ts).
  test: { status: "passed" | "failed"; story: string; checkedAt: string } | null;
  problem: { text: string; step: string | null; fix: "rewrite" | "replan" | "plan" } | null;
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
  // The code review of the version shown (none before its first).
  review: VersionReviewDTO | null;
}

// A version's code review, in plain words: never code.
export interface VersionReviewDTO {
  status: "passed" | "blocked" | "unreviewed";
  findings: { step: string; severity: "blocking" | "warning"; finding: string }[];
  by: "local" | "serv";
  reviewedAt: string;
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
  // Its model cost this week against its budget (USDC minor units).
  budget: BudgetDTO;
}

export interface BudgetDTO {
  spentThisWeek: string;
  spentToday: string;
  budget: string;
  makerDefault: string;
  ceiling: string;
  // A free agent runs on the platform's weekly allowance.
  free: boolean;
  allowance: string;
  // Its renter pays each job's model cost on top of the fee.
  modelShare: boolean;
  decimals: number;
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

// An agent version's quality, from Reppo's scores of a sample of its
// finished jobs: the rolling score (null until enough were reviewed), how
// many were and the share routed ship, review and block (whole percents),
// and the last earlier version's score as history.
export interface QualityDTO {
  score: number | null;
  reviewed: number;
  minimum: number;
  ship: number;
  review: number;
  block: number;
  previous: { version: number; score: number; reviewed: number } | null;
}

// One of a maker's jobs Reppo scored, with nothing of its renter's.
export interface ScoredJobDTO {
  id: string;
  at: string;
  version: number;
  score: number | null;
  route: "ship" | "review" | "block" | null;
  confidence: string | null;
  reason: string | null;
  rubric: Record<string, number>;
  // Routed to block and waiting for an admin to look.
  flagged: boolean;
}

// An agent on the board, for anyone: what it does, what it connects to,
// its price (USDC minor units, with the decimals) and who made it. Never
// its code, its prompts or anyone's data. Its quality is its listed
// version's, from Reppo (a score once enough jobs were reviewed); its trust
// score is its listed version's too (a fixed formula, explained).
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
  quality: QualityDTO;
  trust: TrustDTO;
  createdAt: string;
  // A rough weekly model cost (USDC minor units), from how often it runs
  // and the model calls a run makes.
  modelEstimate: string;
}

// An agent's own page: the listing, and the plan in plain words. Steps are
// titles (and a decision's outcomes), never code or prompts.
export interface AgentPageDTO extends AgentListingDTO {
  done: string;
  runs: string[];
  steps: { kind: "works" | "decides" | "acts" | "repeats"; title: string; outcomes: string[] }[];
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
  // The maker's default weekly model budget for each renter (USDC minor
  // units, within the platform's ceiling), and whether renters pay their
  // jobs' model cost on top of the fee.
  modelBudget: string;
  modelBudgetCeiling: string;
  modelShare: boolean;
  // SERV's screen: public (ok), waiting for an admin (held, with why), or
  // hidden by one.
  screen: "ok" | "held" | "hidden";
  screenReason: string | null;
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
  kind: StepKind;
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
  plan: { id: string; title: string; kind: StepKind }[];
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
  // Reppo's second opinion, for payments and new contacts: still being
  // checked, ready (a score, a route and why), or none this time. Absent
  // when none was asked for. Never the decision: the answer is.
  opinion?: { state: "checking" | "ready" | "none"; score: number | null; route: "ship" | "review" | "block" | null; reason: string | null } | null;
  options: { label: string; effect: string }[];
  // For a payment: what the money is (test USDC on Base Sepolia in the beta).
  money?: MoneyKind | null;
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
    // The platform's 10% of paid uses, all time, less fees given back.
    fees: string;
    problem: string | null;
  }[];
  approvals: AdminWithdrawalDTO[];
  history: AdminWithdrawalDTO[];
  // Agents' payments from the treasury: the site wide switch, the floor
  // the treasury keeps, today's payments, and reconciliation with the chain.
  agentPayments: AgentPaymentsAdminDTO;
  unmatched: { id: string; currency: "USDC" | "SERV"; amount: string; from: string; txHash: string; seenAt: string }[];
}

export interface AgentPaymentsAdminDTO {
  // Why they are paused site wide, or null when they run.
  paused: string | null;
  // USDC minor units: the least the treasury keeps, and the site's day cap.
  floor: string;
  siteCap: string;
  today: { count: number; total: string; failed: number; inFlight: number };
  // The block reconciliation reached and when, and its open alerts.
  reconcile: { block: string | null; at: string | null; open: { id: string; kind: string; message: string; at: string }[] };
  // Today's payments, newest first.
  recent: { id: string; agent: string; renter: string; payee: string; amount: string; status: "held" | "broadcast" | "confirmed" | "failed"; txHash: string | null; at: string }[];
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
  | { type: "reply_end"; messageId?: string; source: string | null; label: string | null; choices: string[] }
  | { type: "done"; messageId?: string; source: string | null; label: string | null }
  // A change asked in the chat for an agent with steps: the agent as its
  // card shows it now, changing (or still being built).
  | { type: "agent"; conversationId: string; agent: AgentSummaryDTO }
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
  // Stopped everywhere by its maker (the kill switch), since when and what
  // they told renters.
  stopped: { at: string; note: string | null } | null;
  // An admin's freeze on it or its maker, if any.
  frozen: string | null;
  // Its listed (or newest) version's quality, and the jobs Reppo scored.
  quality: QualityDTO | null;
  scored: ScoredJobDTO[];
  // Jobs Reppo routed to block that an admin hasn't looked at yet.
  flagged: number;
  // Trust: its listed (or newest) version's and the maker's own, each with
  // every factor, and their trends (a score a day, oldest first).
  trust: { version: TrustDTO | null; maker: TrustDTO; versionTrend: { day: string; score: number }[]; makerTrend: { day: string; score: number }[] };
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
  // Waiting for an admin after SERV's screen (shown to its poster only).
  held: string | null;
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
  // Waiting for an admin after SERV's screen (shown to its maker only).
  held: string | null;
}

// A request on its own page, with its offers (withdrawn ones left out).
export interface RequestPageDTO {
  request: RequestDTO;
  offers: OfferDTO[];
}

// The admin's safety page.
export interface FreezeDTO {
  id: string;
  kind: "agent" | "version" | "maker" | "renter";
  target: string;
  targetId: string;
  reason: string;
  by: string;
  createdAt: string;
  lifted: { at: string; by: string; reason: string } | null;
}

// The moderation queue: open reports, and what the screen held back.
export interface ModerationQueueDTO {
  reports: { id: string; kind: "agent" | "maker" | "request" | "offer"; target: string; targetId: string; reason: string; reasonWords: string; note: string; by: string; createdAt: string }[];
  held: { type: "listing" | "request" | "offer"; id: string; title: string; by: string; reason: string }[];
  // Jobs Reppo's quality checks routed to block, with Reppo's reason.
  // Agent payment alerts: the treasury low, a payment and its transfer not
  // matching, a transfer nobody here made.
  payments: { id: string; kind: string; message: string; details: Record<string, unknown>; at: string }[];
  blocked: { id: string; agentId: string; agent: string; version: number; maker: string; score: number | null; reason: string; at: string }[];
  // Renters' open disputes, oldest first, to uphold or reject; upheld rent
  // disputes waiting for a refund, and whether the ledger can take refunds
  // yet (scripts/sql/ledger-kinds.sql).
  disputes: { open: (DisputeDTO & { renter: string; maker: string })[]; waiting: number; ledgerReady: boolean };
}

// Reppo's quality checks, for the admin: credits used, what is in flight
// and waiting, why nothing goes out (when so), and the settings in force.
export interface ReppoAdminDTO {
  on: boolean;
  today: { credits: number; evals: number };
  week: { credits: number; evals: number };
  inFlight: number;
  queued: number;
  failedToday: number;
  paused: string | null;
  budgetSpent: boolean;
  settings: { firstJobs: number; sampleEvery: number; weeklyPerAgent: number; dailyCredits: number; actionOpinions: boolean };
  creditsPerEval: number;
}

export interface AdminSafetyDTO {
  // The lowest trust scores, versions and makers, with their biggest factor.
  trust: {
    versions: { versionId: string; agent: string; version: number; score: number; label: string; top: string }[];
    makers: { makerId: string; maker: string; score: number; label: string; top: string }[];
  };
  reppo: ReppoAdminDTO;
  queue: ModerationQueueDTO;
  // Every freeze, newest first: the admin log.
  freezes: FreezeDTO[];
  // The installations whose model calls cost the most this week (USDC
  // minor units), and what of that the site paid.
  costs: { installationId: string; name: string; owner: string; maker: string; week: string; sitePaid: string; calls: number; decimals: number }[];
  // Every model call this week by what it was for: agents' own (decisions,
  // the guard's checks, screening in runs) and boardofserv's (code reviews,
  // publish reviews, screening posts and outside runs), with tokens and
  // cost; and what boardofserv paid today for its own calls against its
  // daily budget (USDC minor units).
  calls: { by: "agents" | "boardofserv"; purpose: string; calls: number; tokens: number; cost: string; sitePaid: string }[];
  platform: { today: string; budget: string };
  // How the model answered this week, by what each call was for (the
  // SERV client's attempt log): calls and the tries they took, tries whose
  // answer came back empty, and calls that needed more than one try.
  answers: { purpose: string; calls: number; attempts: number; empty: number; retried: number }[];
  reviews: { versionId: string; agentId: string; name: string; maker: string; version: number; state: "draft" | "published"; review: VersionReviewDTO }[];
}

// One line of the audit log of guarded actions. The maker's view leaves
// out what the renter's data could show: the call in words, the reasons
// and amounts (null there), and names renters by number.
export interface AuditEntryDTO {
  id: string;
  at: string;
  agent: string;
  // Who runs it: null in the renter's own view; "You" or "Renter 2" for
  // the maker; a handle for an admin.
  renter: string | null;
  step: string;
  tool: string;
  risk: "read" | "write" | "outbound" | "money";
  what: string | null;
  outcome: "ran" | "failed" | "asked" | "declined" | "blocked" | "stopped";
  guard: "allow" | "ask" | "block" | "unavailable" | null;
  guardReason: string | null;
  reason: string | null;
  approvedBy: "renter" | "rules" | null;
  // The model cost of its check (USDC minor units), and USDC it spent.
  cost: string;
  spent: string | null;
  decimals: number;
}

export interface AuditPageDTO {
  entries: AuditEntryDTO[];
  // The cursor for older entries, or null at the start of the log.
  next: string | null;
}

// An installation's spending, for its renter: its allowance (USDC minor
// units, the decimals given), what they can top it up with, and its recent
// entries. Later parts add payees, receipts, limits and disputes.
export interface SpendingDTO {
  installationId: string;
  agentName: string;
  decimals: number;
  allowance: { available: string; held: string; max: string };
  // The renter's own balance they can top up from.
  balanceAvailable: string;
  entries: { kind: "topup" | "withdraw" | "hold" | "release" | "spend"; amount: string; at: string }[];
  // Who its agent may pay: saved ones, and suggestions waiting for the
  // renter to confirm on screen. paidBefore is false until a first
  // payment to the address went out (the first always asks); warning says
  // why a payment to the address is high risk and always asks.
  payees: { id: string; label: string; address: string; status: "active" | "suggested"; paidBefore: boolean; createdAt: string; warning: string | null }[];
  // Every payment its agent made or tried, newest first.
  receipts: ReceiptDTO[];
  // What it may pay without asking now (USDC minor units): the stricter of
  // the renter's auto limit and its trust band, per payment, and the band's
  // day; what it paid today; why, in words; and why it can't pay at all.
  limit: { perPayment: string; perDay: string; paidToday: string; why: string; band: string; trust: TrustDTO; stopped: string | null };
  // Agent payments paused site wide, and why.
  paused: string | null;
  // What the money is: test USDC on Base Sepolia in the beta.
  money: MoneyKind;
  // How many days after a payment or week it can be disputed.
  disputeDays: number;
}

// A renter's dispute of an agent payment or a week's rent, and what an
// admin decided. An upheld rent dispute is refunded through the ledger
// ("waiting" until the ledger can take refunds); a payment on chain can't
// be pulled back, so an upheld payment dispute counts against the agent's
// trust score instead.
export interface DisputeDTO {
  id: string;
  kind: "payment" | "rent";
  installationId: string | null;
  agentName: string;
  // What is disputed, in words: "5.00 USDC to Weftworks on 9 Nov" or "Rent for week 3".
  what: string;
  amount: string;
  decimals: number;
  reason: string;
  reasonWords: string;
  note: string;
  status: "open" | "upheld" | "rejected";
  resolution: string | null;
  refund: "none" | "waiting" | "done";
  createdAt: string;
  resolvedAt: string | null;
}

// Something a renter can still dispute: a confirmed agent payment or a
// paid rent week, inside the dispute window and not disputed yet.
export interface DisputableDTO {
  kind: "payment" | "rent";
  installationId: string | null;
  // The payment's id, or "<rental id>:<week>".
  id: string;
  agentName: string;
  what: string;
  amount: string;
  until: string;
}

// A payment's receipt: what, to whom, by which agent and job, its
// transfer on Base (with an explorer link), what the safety check said
// and who approved it. Nothing here is secret: it is the renter's own.
export interface ReceiptDTO {
  id: string;
  amount: string;
  decimals: number;
  payee: { label: string; address: string };
  agent: string;
  jobId: string | null;
  memo: string | null;
  status: "held" | "broadcast" | "confirmed" | "failed";
  txHash: string | null;
  explorer: string | null;
  network: string;
  guard: { verdict: string | null; reason: string | null };
  approval: { by: "renter" | "rules" | null; question: string | null; answer: string | null; at: string | null };
  error: string | null;
  createdAt: string;
  settledAt: string | null;
}

// A trust score (300 to 850) for an agent version or a maker: a fixed
// formula, with the factors that explain it (points each, in words; points
// earned while new are shown but not counted yet) and the spending band it
// sets (whole USDC an agent may pay without asking, per payment and day).
export interface TrustDTO {
  score: number;
  label: "new" | "low" | "fair" | "good" | "strong" | "excellent";
  isNew: boolean;
  factors: { key: string; words: string; points: number; counted: boolean }[];
  band: { label: string; perPayment: number; perDay: number };
  computedAt: string | null;
}
