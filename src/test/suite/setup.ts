import { randomBytes } from "node:crypto";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type * as schema from "@/lib/db/schema";
import { keep } from "@/lib/connections/vault";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { addUser } from "../helperDb";
import { SUITE } from "./requests";

// What the suite's makers have before they start, the same live and
// offline: their Telegram linked and Google connected (stand-ins: no
// message is sent and no sheet is opened), and every spreadsheet they pick
// at Connect answering with the tabs the suite's requests name.

process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");

export const SUITE_TABS = [...new Set(SUITE.flatMap((r) => r.tabs ?? []).concat("Sheet1"))];

export async function sheetInfo(_rt: unknown, _owner: string, spreadsheetId: string) {
  return { spreadsheetId, title: "The maker's sheet", tabs: SUITE_TABS.map((title, i) => ({ id: i + 1, title })) };
}

export async function suiteMaker(db: PgliteDatabase<typeof schema>, id: string): Promise<schema.User> {
  const user = await addUser(db, `suite.${id}`);
  const rt = serverRuntime();
  await keep(rt, user.id, "telegram", `@suite_${id}`, { chatId: 1000 + SUITE.findIndex((r) => r.id === id), userId: 1000 + SUITE.findIndex((r) => r.id === id) });
  await keep(rt, user.id, "google", `${id}@example.com`, { refreshToken: "stand-in", accessToken: null, expiresAt: null, scope: "https://www.googleapis.com/auth/spreadsheets" });
  return user;
}
