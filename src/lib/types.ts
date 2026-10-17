// Shapes the browser works with. Dates arrive as ISO strings over JSON.
export interface ConversationDTO {
  id: string;
  title: string;
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

export type ChatEvent =
  | { type: "meta"; conversationId: string; source: string; label: string }
  | { type: "delta"; text: string }
  | { type: "done"; messageId?: string; source: string; label: string }
  | { type: "error"; message: string };
