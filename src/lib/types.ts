// Shapes the browser works with. Dates arrive as ISO strings over JSON.
export interface ConversationDTO {
  id: string;
  title: string;
  // The agent sketch's name, once the conversation has one.
  sketchName: string | null;
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
export interface SketchDTO {
  name: string | null;
  kind: "watcher" | "digest" | "helper" | null;
  watches: string | null;
  when: string | null;
  how: string | null;
  tells: string | null;
  // The one field the latest reply asks about.
  asking: "watches" | "when" | "how" | "tells" | null;
  live: boolean;
}

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
