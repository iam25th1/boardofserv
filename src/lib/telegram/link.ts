import "server-only";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { telegramLinkCodes, telegramWebhook } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import { botUsername } from "./api";

// Linking an owner's Telegram chat, and the webhook's secret.
//
// The owner asks boardofserv for a code and sends the bot /start CODE from
// the chat they want linked (or opens t.me/<bot>?start=CODE, which sends
// it for them). A code is kept only as a hash, works once, and only within
// ten minutes. Telegram's deep links take up to 64 of A-Z, a-z, 0-9, _ and
// -; a code is ten letters and digits, with none that look alike.

export const CODE_MINUTES = 10;
const CODE_LENGTH = 10;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Codes an owner may have waiting at once.
const MAX_OPEN_CODES = 5;

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
export const codeHash = (code: string) => sha256(`telegram-link:${code.trim().toUpperCase()}`);

export class CodeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeRefused";
  }
}

export interface LinkCode {
  code: string;
  link: string;
  bot: string;
  expiresAt: string;
}

export async function newLinkCode(rt: Runtime, ownerUserId: string): Promise<LinkCode> {
  const now = rt.now();
  const [open] = await rt.db
    .select({ n: count() })
    .from(telegramLinkCodes)
    .where(and(eq(telegramLinkCodes.ownerUserId, ownerUserId), isNull(telegramLinkCodes.usedAt), gt(telegramLinkCodes.expiresAt, now)));
  if ((open?.n ?? 0) >= MAX_OPEN_CODES) throw new CodeRefused(`You have ${MAX_OPEN_CODES} codes waiting already. Use one, or wait ${CODE_MINUTES} minutes.`);
  const bot = await botUsername(rt.services);
  const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const expiresAt = new Date(now.getTime() + CODE_MINUTES * 60_000);
  await rt.db.insert(telegramLinkCodes).values({ codeHash: codeHash(code), ownerUserId, expiresAt, createdAt: now });
  return { code, link: `https://t.me/${bot}?start=${code}`, bot, expiresAt: expiresAt.toISOString() };
}

// The owner a code was made for, using it up: null for a code that is
// wrong, used or out of time.
export async function redeemLinkCode(rt: Runtime, code: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(code.trim())) return null;
  const now = rt.now();
  const [row] = await rt.db
    .update(telegramLinkCodes)
    .set({ usedAt: now })
    .where(and(eq(telegramLinkCodes.codeHash, codeHash(code)), isNull(telegramLinkCodes.usedAt), gt(telegramLinkCodes.expiresAt, now)))
    .returning({ owner: telegramLinkCodes.ownerUserId });
  return row?.owner ?? null;
}

// The webhook's secret. Telegram sends it in X-Telegram-Bot-Api-Secret-Token
// with every update; only its hash is kept. The one before it is still
// taken for a few minutes after a change, while Telegram moves over.
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";
const PREVIOUS_GRACE_MS = 10 * 60_000;

export function newWebhookSecret(): string {
  // 1-256 of A-Z, a-z, 0-9, _ and -: base64url is exactly those.
  return randomBytes(32).toString("base64url");
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function storeWebhookSecret(rt: Runtime, secret: string): Promise<void> {
  const now = rt.now();
  const [row] = await rt.db.select().from(telegramWebhook).where(eq(telegramWebhook.id, 1));
  const values = { secretHash: sha256(secret), previousHash: row?.secretHash ?? null, setAt: now };
  await rt.db.insert(telegramWebhook).values({ id: 1, ...values }).onConflictDoUpdate({ target: telegramWebhook.id, set: values });
}

// Puts back the secret before the last change (setting the webhook failed).
export async function restoreWebhookSecret(rt: Runtime): Promise<void> {
  const [row] = await rt.db.select().from(telegramWebhook).where(eq(telegramWebhook.id, 1));
  if (!row) return;
  if (row.previousHash) await rt.db.update(telegramWebhook).set({ secretHash: row.previousHash, previousHash: null }).where(eq(telegramWebhook.id, 1));
  else await rt.db.delete(telegramWebhook).where(eq(telegramWebhook.id, 1));
}

// Whether a request carries the webhook's secret. In development only, the
// fake updates of scripts/telegram-fake-update.ts carry
// TELEGRAM_DEV_WEBHOOK_SECRET instead, so trying it locally never touches
// the live bot's secret.
export async function webhookSecretOk(rt: Runtime, given: string | null): Promise<boolean> {
  if (!given || given.length > 256) return false;
  if (process.env.NODE_ENV !== "production") {
    const dev = process.env.TELEGRAM_DEV_WEBHOOK_SECRET;
    if (dev && same(sha256(given), sha256(dev))) return true;
  }
  const [row] = await rt.db.select().from(telegramWebhook).where(eq(telegramWebhook.id, 1));
  if (!row) return false;
  const hash = sha256(given);
  if (same(hash, row.secretHash)) return true;
  return Boolean(row.previousHash && rt.now().getTime() - row.setAt.getTime() < PREVIOUS_GRACE_MS && same(hash, row.previousHash));
}
