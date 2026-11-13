// Typeform's Create and Responses APIs, read with the owner's own personal
// token (connected on Connections, kept in the vault). Only what an agent
// needs: whether a token works, a form's questions, and its responses with
// each answer under its question's title. The token goes in one header and
// nowhere else: errors carry Typeform's status, never the token.

const API = "https://api.typeform.com";
const TIMEOUT_MS = 15_000;

export class TypeformError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "TypeformError";
  }
}

// A form's id from its link (https://form.typeform.com/to/AbC123, a
// workspace's own subdomain, or the admin page), or the id itself.
export function formIdOf(link: string): string | null {
  const t = link.trim();
  if (/^[A-Za-z0-9]{4,20}$/.test(t)) return t;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (!/(^|\.)typeform\.com$/i.test(u.hostname)) return null;
  const m = /\/(?:to|form)\/([A-Za-z0-9]{4,20})(?:[/?#]|$)/.exec(u.pathname + "/");
  return m?.[1] ?? null;
}

async function call<T>(fetchImpl: typeof fetch, token: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new TypeformError("Typeform couldn't be reached just now.", null);
  }
  if (res.status === 401 || res.status === 403) throw new TypeformError("Typeform turned the token down: it may have been deleted, or it can't read forms and responses.", res.status);
  if (res.status === 404) throw new TypeformError("Typeform has no such form for this account.", 404);
  if (!res.ok) throw new TypeformError(`Typeform answered with status ${res.status}.`, res.status);
  return (await res.json()) as T;
}

// Whose token it is, as the owner would know the account (its alias,
// never its email address), or why it doesn't work.
export async function tokenAccount(fetchImpl: typeof fetch, token: string): Promise<string> {
  const me = await call<{ alias?: string }>(fetchImpl, token, "/me");
  return me.alias?.trim().slice(0, 60) || "your account";
}

export interface FormQuestion {
  id: string;
  title: string;
  type: string;
}

interface RawField {
  id: string;
  title?: string;
  type?: string;
  properties?: { fields?: RawField[] };
}

// The form's questions, in order, a group's questions with them.
export async function formQuestions(fetchImpl: typeof fetch, token: string, formId: string): Promise<{ title: string; questions: FormQuestion[] }> {
  const form = await call<{ title?: string; fields?: RawField[] }>(fetchImpl, token, `/forms/${encodeURIComponent(formId)}`);
  const flat = (fields: RawField[]): FormQuestion[] =>
    fields.flatMap((f) => [...(f.type === "group" ? [] : [{ id: f.id, title: plainTitle(f.title ?? f.id), type: f.type ?? "" }]), ...flat(f.properties?.fields ?? [])]);
  return { title: form.title ?? formId, questions: flat(form.fields ?? []) };
}

// A question's title as people read it: Typeform's recall marks and
// formatting stars taken out.
const plainTitle = (t: string) =>
  t
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/[*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

interface RawAnswer {
  field: { id: string };
  type: string;
  text?: string;
  email?: string;
  url?: string;
  number?: number;
  boolean?: boolean;
  date?: string;
  phone_number?: string;
  file_url?: string;
  choice?: { label?: string; other?: string };
  choices?: { labels?: string[]; other?: string };
}

export interface FormResponse {
  // The response's own id, the same however often it is read.
  id: string;
  submittedAt: string;
  // Every question's answer under its title; null when it wasn't answered.
  answers: Record<string, string | number | boolean | string[] | null>;
}

function answerOf(a: RawAnswer): string | number | boolean | string[] | null {
  switch (a.type) {
    case "choice":
      return a.choice?.label ?? a.choice?.other ?? null;
    case "choices":
      return [...(a.choices?.labels ?? []), ...(a.choices?.other ? [a.choices.other] : [])];
    case "number":
      return a.number ?? null;
    case "boolean":
      return a.boolean ?? null;
    default:
      return a.text ?? a.email ?? a.url ?? a.date ?? a.phone_number ?? a.file_url ?? null;
  }
}

export function mapResponse(r: { response_id?: string; token?: string; submitted_at?: string; answers?: RawAnswer[] | null }, questions: FormQuestion[]): FormResponse {
  const byId = new Map((r.answers ?? []).map((a) => [a.field.id, a]));
  const answers: FormResponse["answers"] = {};
  for (const q of questions) {
    const a = byId.get(q.id);
    answers[q.title] = a ? answerOf(a) : null;
  }
  return { id: r.response_id ?? r.token ?? "", submittedAt: r.submitted_at ?? "", answers };
}

// The form's completed responses, oldest first, each with its answers by
// question title: up to `limit`, leaving out the ids in `skip`.
export async function formResponses(fetchImpl: typeof fetch, token: string, formId: string, o: { skip?: Set<string>; limit?: number } = {}): Promise<{ title: string; questions: FormQuestion[]; responses: FormResponse[] }> {
  const form = await formQuestions(fetchImpl, token, formId);
  const page = await call<{ items?: { response_id?: string; token?: string; submitted_at?: string; answers?: RawAnswer[] | null }[] }>(
    fetchImpl,
    token,
    `/forms/${encodeURIComponent(formId)}/responses?page_size=200&completed=true&sort=submitted_at,asc`,
  );
  const responses = (page.items ?? [])
    .map((r) => mapResponse(r, form.questions))
    .filter((r) => r.id && !o.skip?.has(r.id))
    .slice(0, o.limit ?? 50);
  return { ...form, responses };
}
