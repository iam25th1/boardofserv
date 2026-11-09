import "server-only";
import type { Runtime } from "../agents/runtime/context";
import type { SecretOf } from "../connections/vault";
import { tg } from "./api";

// The last message to a chat being unlinked, so its owner knows the bot
// has gone quiet on purpose.
export const farewell = (rt: Runtime) => async (secret: SecretOf<"telegram" | "google">) => {
  const chatId = (secret as SecretOf<"telegram">).chatId;
  if (typeof chatId !== "number") return;
  await tg(rt.services, "sendMessage", { chat_id: chatId, text: "This chat is unlinked from boardofserv: your agents won't message you here. Link it again any time from Connections." });
};
