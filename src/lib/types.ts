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
  email: string | null;
  walletAddress: string | null;
  openservUserId: string | null;
  linked: boolean;
  balance: "ok" | "low" | "unknown";
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
  // The maker's handle, without the @.
  maker: string;
  createdAt: string;
}

// A signed-in user's uses of published helpers today. Uses run on the
// operator's key until payments exist, so each user has a daily limit.
export interface QuotaDTO {
  limit: number;
  remaining: number;
  // When the count starts again (midnight UTC), as an ISO string.
  resetsAt: string;
}

// One use of a helper, as the server streams it.
export type HelperEvent =
  | { type: "meta"; source: string; label: string }
  | { type: "delta"; text: string }
  // The answer was stopped for carrying the helper's instructions.
  | { type: "blocked"; message: string; quota: QuotaDTO }
  | { type: "done"; quota: QuotaDTO }
  | { type: "error"; message: string; quota?: QuotaDTO };

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
