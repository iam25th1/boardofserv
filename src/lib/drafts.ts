"use client";
// Unsent drafts survive a reload and switching conversations. Stored per
// conversation key in localStorage, wrapped so a private window or blocked
// storage never throws.
const PREFIX = "bos-draft:";

export function loadDraft(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(PREFIX + key, value);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // storage unavailable, drafts simply do not persist this session
  }
}
