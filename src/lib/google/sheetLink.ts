// Google Sheets links, read the same way in the browser and on the server:
// a spreadsheet's id, and its tab's id when the link names one, from a
// link like https://docs.google.com/spreadsheets/d/<id>/edit#gid=<tab>.

export function parseSheetLink(link: string): { spreadsheetId: string; gid: number | null } | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
  const m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(?:\/|$)/.exec(u.pathname);
  if (!m) return null;
  const gid = /(?:^|[#&?])gid=(\d{1,12})/.exec(`${u.search}${u.hash}`);
  return { spreadsheetId: m[1]!, gid: gid ? Number(gid[1]) : null };
}

export const sheetLink = (spreadsheetId: string, tabId?: number) => `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit${tabId === undefined ? "" : `#gid=${tabId}`}`;

// A sheet setting's answer on the way to the server: the link the owner
// pasted and the tab they picked.
export interface SheetAnswer {
  url: string;
  tab: string;
}

export const isSheetAnswer = (v: unknown): v is SheetAnswer =>
  Boolean(v) && typeof v === "object" && typeof (v as SheetAnswer).url === "string" && typeof (v as SheetAnswer).tab === "string";
