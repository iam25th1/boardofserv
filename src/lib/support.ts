// The support email is the owner's to fill in: SUPPORT_EMAIL in the
// service's environment (read when the site is built). Without a valid
// one, the support page says Telegram is the way.
export function supportEmail(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.SUPPORT_EMAIL?.trim() ?? "";
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) ? v : null;
}
