import type { QuotaDTO } from "./types";

// What the day's limits say, on the server and next to the composer (see
// spend.ts for the limits themselves).

export const LIMIT_MESSAGE = "boardofserv has hit today's limit. It resets at midnight UTC.";

export function chatLimitMessage(quota: Pick<QuotaDTO, "limit">): string {
  return `You've used today's ${quota.limit} messages. They reset at midnight UTC.`;
}

// Shown near the composer once fewer than this many messages are left.
export const FEW_MESSAGES = 10;

export function messagesLeft(remaining: number): string {
  return remaining === 1 ? "1 message left today" : `${remaining} messages left today`;
}
