import type { PublicHelperDTO } from "./types";

// Calls that need no sign-in: the board and a helper's public page.

export async function fetchBoard(q: string, signal?: AbortSignal): Promise<PublicHelperDTO[]> {
  const res = await fetch(`/api/board${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`, { signal });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return ((await res.json()) as { helpers: PublicHelperDTO[] }).helpers;
}

export type HelperPage = { helper: PublicHelperDTO } | { takenDown: string } | { missing: true };

export async function fetchHelper(slug: string, signal?: AbortSignal): Promise<HelperPage> {
  const res = await fetch(`/api/helpers/${encodeURIComponent(slug)}`, { signal });
  if (res.status === 404) return { missing: true };
  if (res.status === 410) return { takenDown: ((await res.json()) as { name: string }).name };
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as { helper: PublicHelperDTO };
}
