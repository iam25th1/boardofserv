import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

// A user of boardofserv, keyed by their Privy user id. We store the Privy
// embedded wallet address and, encrypted, the OpenServ API key that this
// wallet's SIWE sign-in produced. The key is ciphertext only (see crypto.ts);
// the plaintext never touches the database or the browser.
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  privyUserId: text("privy_user_id").notNull().unique(),
  email: text("email"),
  walletAddress: text("wallet_address"),
  // OpenServ linkage.
  openservUserId: text("openserv_user_id"),
  openservKeyEncrypted: text("openserv_key_encrypted"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
