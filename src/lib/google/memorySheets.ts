// Google Sheets' API in memory, for tests and the development demo only
// (nothing in production imports it): spreadsheets by id with their tabs'
// cells, enough of the API for the sheet tools: a spreadsheet's tabs, a
// tab's values, writing from A1, appending, clearing, and writing single
// cells in a batch. Ranges name a tab, quoted, maybe with cells after it.

export interface MemoryTab {
  id: number;
  title: string;
  values: unknown[][];
}

function toValues(rows: Record<string, unknown>[]): unknown[][] {
  const head = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [head, ...rows.map((r) => head.map((h) => (r[h] === undefined || r[h] === null ? "" : r[h])))];
}

function toRows(values: unknown[][]): Record<string, unknown>[] {
  const [head = [], ...rest] = values;
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [String(h), r[i] === "" || r[i] === undefined ? null : r[i]])));
}

export class MemorySheets {
  readonly books = new Map<string, { title: string; tabs: MemoryTab[] }>();

  // A spreadsheet made of tabs of records (the first row names the columns).
  add(id: string, title: string, tabs: Record<string, Record<string, unknown>[]>): string {
    this.books.set(id, { title, tabs: Object.entries(tabs).map(([t, rows], i) => ({ id: i === 0 ? 0 : 1000 + i, title: t, values: rows.length ? toValues(rows) : [] })) });
    return id;
  }

  // A tab's rows, as records.
  rows(id: string, tab: string): Record<string, unknown>[] {
    return toRows(this.books.get(id)?.tabs.find((t) => t.title === tab)?.values ?? []);
  }

  // One request to sheets.googleapis.com.
  answer(url: URL, method: string, body: string | null): Response {
    const batch = /^\/v4\/spreadsheets\/([^/]+)\/values:batchUpdate$/.exec(url.pathname);
    if (batch && method === "POST") return this.batch(decodeURIComponent(batch[1]!), body);
    const m = /^\/v4\/spreadsheets\/([^/]+)(?:\/values\/([^:?]+)(?::(append|clear))?)?$/.exec(url.pathname);
    if (!m) return Response.json({ error: { message: "no such call" } }, { status: 400 });
    const book = this.books.get(decodeURIComponent(m[1]!));
    if (!book) return Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 });
    if (!m[2]) return Response.json({ properties: { title: book.title }, sheets: book.tabs.map((t) => ({ properties: { sheetId: t.id, title: t.title, sheetType: "GRID" } })) });
    const range = decodeURIComponent(m[2]);
    const r = /^'((?:[^']|'')+)'(?:!(.+))?$/.exec(range);
    const tab = r ? book.tabs.find((t) => t.title === r[1]!.replace(/''/g, "'")) : undefined;
    if (!tab) return Response.json({ error: { message: `Unable to parse range: ${range}` } }, { status: 400 });
    const values = (): unknown[][] => {
      try {
        return ((JSON.parse(body ?? "{}") as { values?: unknown[][] }).values ?? []) as unknown[][];
      } catch {
        return [];
      }
    };
    if (m[3] === "clear") {
      tab.values = [];
      return Response.json({ clearedRange: range });
    }
    if (m[3] === "append") {
      const v = values();
      tab.values.push(...v);
      return Response.json({ updates: { updatedRows: v.length } });
    }
    if (method === "PUT") {
      const v = values();
      v.forEach((row, i) => (tab.values[i] = row));
      return Response.json({ updatedRows: v.length });
    }
    const out = r![2] === "1:1" ? tab.values.slice(0, 1) : tab.values;
    return Response.json({ range, majorDimension: "ROWS", ...(out.length ? { values: out } : {}) });
  }

  // values:batchUpdate with single cells ('Tab'!C2), as sheets.update sends.
  private batch(id: string, body: string | null): Response {
    const book = this.books.get(id);
    if (!book) return Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 });
    const data = ((JSON.parse(body ?? "{}") as { data?: { range: string; values: unknown[][] }[] }).data ?? []);
    for (const d of data) {
      const r = /^'((?:[^']|'')+)'!([A-Z]+)(\d+)$/.exec(d.range);
      const tab = r ? book.tabs.find((t) => t.title === r[1]!.replace(/''/g, "'")) : undefined;
      if (!r || !tab) return Response.json({ error: { message: `Unable to parse range: ${d.range}` } }, { status: 400 });
      const col = [...r[2]!].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
      const row = Number(r[3]) - 1;
      while (tab.values.length <= row) tab.values.push([]);
      const line = tab.values[row]!;
      while (line.length <= col) line.push("");
      line[col] = d.values?.[0]?.[0] ?? "";
    }
    return Response.json({ totalUpdatedCells: data.length });
  }
}
