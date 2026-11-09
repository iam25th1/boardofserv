import "server-only";
import type { Runtime } from "../agents/runtime/context";
import type { SheetGrant } from "../db/schema";
import { accessToken, GoogleUnavailable } from "./oauth";

// Google Sheets for agents (developers.google.com/workspace/sheets/api),
// on the owner's own Google access. A tab reads as rows: its first row
// names the columns, each row after it is a record of those columns. A
// write adds rows under the last one (append), or clears the tab and
// writes the header and rows again (replace); a key no column has yet
// becomes a new column. Values go in as they are (RAW), never as
// formulas, so nothing an agent writes is run by the sheet.
//
// Google's limits: 60 requests a minute per user and 300 per project, a
// 429 past them. boardofserv keeps each owner under 50 a minute, and a 429
// (or Google being unreachable) is worth another try later.

const API = "https://sheets.googleapis.com/v4/spreadsheets";
export const MAX_ROWS = 2000;
const MAX_CELL = 2000;
const PER_MINUTE = 50;

export type Cell = string | number | boolean | null;
export type SheetRow = Record<string, Cell>;

// Google said the owner (or boardofserv) may not do that: an answer for
// the agent, not worth trying again.
export class SheetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetRefused";
  }
}

export { parseSheetLink, sheetLink } from "./sheetLink";

// A tab's name as a range: quoted, with quotes doubled.
const range = (tab: string, cells = "") => encodeURIComponent(`'${tab.replace(/'/g, "''")}'${cells}`);

const minute = new Map<string, number[]>();
function underLimit(ownerUserId: string, now: number): boolean {
  const recent = (minute.get(ownerUserId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_MINUTE) {
    minute.set(ownerUserId, recent);
    return false;
  }
  recent.push(now);
  minute.set(ownerUserId, recent);
  return true;
}

// One Sheets API call on the owner's access, the token refreshed and the
// call made once more when Google says it ran out.
async function call<T>(rt: Runtime, ownerUserId: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  if (!underLimit(ownerUserId, rt.now().getTime())) throw new GoogleUnavailable("Google's limit of requests a minute was reached; it tries again shortly.");
  for (let tries = 0; ; tries++) {
    const token = await accessToken(rt, ownerUserId, tries > 0);
    if (!token) throw new SheetRefused("Google isn't connected, so its sheets can't be opened. Connect Google on Connections.");
    let res: Response;
    try {
      res = await rt.services.fetch(`${API}/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GoogleUnavailable("Google Sheets couldn't be reached just now.");
    }
    if (res.status === 401 && tries === 0) continue;
    if (res.ok) return (await res.json().catch(() => ({}))) as T;
    if (res.status === 403) throw new SheetRefused("Google says this Google account may not open that sheet. Share it with the account, or pick another.");
    if (res.status === 404) throw new SheetRefused("That sheet isn't there any more (or the link is wrong).");
    if (res.status === 400) {
      const why = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
      throw new SheetRefused(`Google refused it${why ? `: ${why.slice(0, 160)}` : "."}`);
    }
    throw new GoogleUnavailable(res.status === 429 ? "Google's rate limit was reached; it tries again shortly." : "Google Sheets had a problem just now.");
  }
}

export interface SheetInfo {
  spreadsheetId: string;
  title: string;
  tabs: { id: number; title: string }[];
}

// A spreadsheet's name and tabs, when the owner may open it.
export async function sheetInfo(rt: Runtime, ownerUserId: string, spreadsheetId: string): Promise<SheetInfo> {
  const got = await call<{ properties?: { title?: string }; sheets?: { properties?: { sheetId?: number; title?: string; sheetType?: string } }[] }>(
    rt,
    ownerUserId,
    "GET",
    `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent("properties.title,sheets.properties(sheetId,title,sheetType)")}`,
  );
  const tabs = (got.sheets ?? [])
    .map((s) => s.properties ?? {})
    .filter((p) => (p.sheetType ?? "GRID") === "GRID" && typeof p.title === "string" && typeof p.sheetId === "number")
    .map((p) => ({ id: p.sheetId!, title: p.title! }));
  return { spreadsheetId, title: got.properties?.title ?? "Untitled spreadsheet", tabs };
}

const cell = (v: unknown): Cell => (typeof v === "number" || typeof v === "boolean" ? v : v === undefined || v === null || v === "" ? null : String(v).slice(0, MAX_CELL));

// A tab's rows, as records of its columns.
export async function readTab(rt: Runtime, ownerUserId: string, g: SheetGrant): Promise<SheetRow[]> {
  const got = await call<{ values?: unknown[][] }>(rt, ownerUserId, "GET", `${encodeURIComponent(g.spreadsheetId)}/values/${range(g.tab)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
  const [head = [], ...rest] = got.values ?? [];
  const columns = head.map((h) => (h === null || h === undefined ? "" : String(h).trim().slice(0, 80)));
  return rest
    .slice(0, MAX_ROWS)
    .filter((r) => r.some((v) => v !== "" && v !== null && v !== undefined))
    .map((r) => Object.fromEntries(columns.flatMap((c, i) => (c ? [[c, cell(r[i])]] : []))));
}

// Rows written to a tab. Returns how many.
export async function writeTab(rt: Runtime, ownerUserId: string, g: SheetGrant, rows: SheetRow[], mode: "append" | "replace"): Promise<number> {
  const id = encodeURIComponent(g.spreadsheetId);
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  let columns: string[];
  if (mode === "replace") {
    columns = keys;
    await call(rt, ownerUserId, "POST", `${id}/values/${range(g.tab)}:clear`, {});
  } else {
    const got = await call<{ values?: unknown[][] }>(rt, ownerUserId, "GET", `${id}/values/${range(g.tab, "!1:1")}?majorDimension=ROWS`);
    const head = (got.values?.[0] ?? []).map((h) => String(h ?? "").trim());
    columns = [...head, ...keys.filter((k) => !head.includes(k))];
    if (columns.length !== head.length) await call(rt, ownerUserId, "PUT", `${id}/values/${range(g.tab, "!A1")}?valueInputOption=RAW`, { values: [columns] });
  }
  const values = rows.map((r) => columns.map((c) => (r[c] === undefined || r[c] === null ? "" : r[c])));
  if (mode === "replace") {
    await call(rt, ownerUserId, "PUT", `${id}/values/${range(g.tab, "!A1")}?valueInputOption=RAW`, { values: [columns, ...values] });
  } else if (values.length) {
    await call(rt, ownerUserId, "POST", `${id}/values/${range(g.tab, "!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values });
  }
  return rows.length;
}

// For tests: forget the minute's counts.
export function resetSheetLimits(): void {
  minute.clear();
}
