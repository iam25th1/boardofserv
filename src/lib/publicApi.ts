import type { PublicHelperDTO } from "./types";

// Calls that need no sign-in: the board and a helper's public page.

export async function fetchBoard(q: string, signal?: AbortSignal): Promise<PublicHelperDTO[]> {
  const res = await fetch(`/api/board${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`, { signal });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return ((await res.json()) as { helpers: PublicHelperDTO[] }).helpers;
}
