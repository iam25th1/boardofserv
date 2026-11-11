import type { ConversationDTO } from "./types";

// What each chat is called in the agents list. A chat with an agent sketch
// goes by the agent's name; one without goes by its title, which is its
// first message (or "New conversation" before there is one). No two look
// the same: a name another chat has too gets a number after the first one
// started ("Price watcher 2"), and a short detail says when each was
// started.

export interface ChatName {
  name: string;
  // Only for chats whose name another chat has too.
  detail: string | null;
}

const started = (iso: string) =>
  `started ${new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}`;

export function chatNames(conversations: readonly Pick<ConversationDTO, "id" | "title" | "sketchName" | "createdAt">[]): Map<string, ChatName> {
  const nameOf = (c: (typeof conversations)[number]) => (c.sketchName ?? c.title).trim() || "New conversation";
  const byName = new Map<string, (typeof conversations)[number][]>();
  for (const c of conversations) {
    const key = nameOf(c).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), c]);
  }
  const out = new Map<string, ChatName>();
  for (const same of byName.values()) {
    if (same.length === 1) {
      out.set(same[0]!.id, { name: nameOf(same[0]!), detail: null });
      continue;
    }
    // Oldest first, so the count follows the order they were started in.
    const ordered = [...same].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const whens = ordered.map((c) => started(c.createdAt));
    ordered.forEach((c, i) => {
      out.set(c.id, { name: i === 0 ? nameOf(c) : `${nameOf(c)} ${i + 1}`, detail: whens[i]! });
    });
  }
  return out;
}
