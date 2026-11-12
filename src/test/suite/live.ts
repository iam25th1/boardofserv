import { readFileSync } from "node:fs";
import { askedSteps } from "../planAnswers";

// The model calls of a suite run: each one counted against its budget and
// listed with its status, tokens and time, never a key; every answer kept,
// by what it was for, so the same run can be answered again offline
// (replay). Only SERV and Dolphin may be called; anything else is refused.

export type To = "serv" | "dolphin";

export interface LiveCall {
  agent: string;
  to: To;
  what: string;
  status: number | "refused" | "error" | "replayed";
  ms: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

// One answer as it came back: its body as text, and the key that finds it
// again (the steps a details call asked for, the step a code call wrote).
export interface Recorded {
  what: string;
  key: string;
  status: number;
  contentType: string;
  body: string;
}

export interface Budget {
  serv: number;
  dolphin: number;
}

// What a call was for: its schema's name, code, or a chat reply.
export function purposeOf(body: { response_format?: { json_schema?: { name?: string } }; messages?: { content?: string }[]; stream?: boolean }): string {
  const name = body.response_format?.json_schema?.name;
  if (name) return name;
  if (String(body.messages?.[0]?.content ?? "").startsWith("You write one JavaScript function")) return "code";
  return body.stream ? "reply" : "text";
}

// What finds a recorded answer again: the steps asked for, or the code
// step's title.
export function keyOf(what: string, asked: string): string {
  if (what === "agent_steps") return askedSteps(asked).join(",");
  if (what === "code" || what === "code_review") return /^Step: (.+)$/m.exec(asked)?.[1] ?? "";
  return "";
}

// Token counts from an answer: a JSON body's usage, or a stream's last.
export function usageOf(text: string): { prompt: number | null; completion: number | null } {
  const pick = (u: { prompt_tokens?: number; completion_tokens?: number } | undefined) => ({ prompt: u?.prompt_tokens ?? null, completion: u?.completion_tokens ?? null });
  try {
    return pick((JSON.parse(text) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage);
  } catch {
    const lines = text.split("\n").filter((l) => l.startsWith("data:") && l.includes('"usage"'));
    for (const l of lines.reverse()) {
      try {
        const u = (JSON.parse(l.slice(5)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
        if (u) return pick(u);
      } catch {
        // not JSON
      }
    }
    return { prompt: null, completion: null };
  }
}

export class Ledger {
  calls: LiveCall[] = [];
  recorded = new Map<string, Recorded[]>();
  agent = "";
  // Per agent: the most each may spend, on top of the run's budget.
  cap: Budget | null = null;
  noServCode = false;
  private pending: Promise<unknown>[] = [];
  private replays = new Map<string, Recorded[]>();

  constructor(
    private budget: Budget,
    private realFetch: typeof fetch,
    replayFile?: string,
    // Only these purposes are answered from the replay; the rest go live.
    private replayOnly?: Set<string>,
    // When a replayed purpose has no answer left, go live (within the
    // budget) rather than refuse.
    private thenLive = false,
  ) {
    if (replayFile) {
      const all = JSON.parse(readFileSync(replayFile, "utf8")) as Record<string, Recorded[]>;
      for (const [id, list] of Object.entries(all)) this.replays.set(id, [...list]);
    }
  }

  spent(to: To, agent?: string): number {
    return this.calls.filter((c) => c.to === to && (agent === undefined || c.agent === agent) && c.status !== "refused" && c.status !== "replayed").length;
  }

  // The next recorded answer for this agent with this purpose and key.
  private replayed(what: string, key: string): Recorded | null {
    const list = this.replays.get(this.agent);
    if (!list) return null;
    const i = list.findIndex((r) => r.what === what && (key === "" || r.key === key));
    return i === -1 ? null : list.splice(i, 1)[0]!;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const to: To | null = url.host.includes("dphn.ai") ? "dolphin" : url.host.includes("openserv.ai") ? "serv" : null;
    if (!to) throw new Error(`suite: refused a call to ${url.host}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Parameters<typeof purposeOf>[0];
    const what = purposeOf(body);
    // The step a code call is for is named in its first request, not in a
    // rewrite's last message.
    const asked = what === "code" ? (body.messages ?? []).map((m) => String(m.content ?? "")).find((c) => /^Step: /m.test(c)) ?? "" : String(body.messages?.at(-1)?.content ?? "");
    const key = keyOf(what, asked);
    const agent = this.agent;
    const note = (c: Omit<LiveCall, "agent" | "to" | "what">) => this.calls.push({ agent, to, what, ...c });
    if (this.replays.size && (!this.replayOnly || this.replayOnly.has(what))) {
      const r = this.replayed(what, key);
      if (r) {
        note({ status: "replayed", ms: 0, promptTokens: null, completionTokens: null });
        // Kept with the run's own answers, so a run partly replayed records
        // every answer it was given, in order.
        const list = this.recorded.get(agent) ?? [];
        this.recorded.set(agent, list);
        list.push({ ...r, key });
        return new Response(r.body, { status: r.status, headers: { "content-type": r.contentType } });
      }
      if (!this.thenLive) {
        note({ status: "refused", ms: 0, promptTokens: null, completionTokens: null });
        throw new Error(`suite: no recorded answer for ${agent} ${what} ${key}`);
      }
    }
    const over = this.spent(to) >= this.budget[to] || (this.cap !== null && this.spent(to, agent) >= this.cap[to]);
    // Without Dolphin's room, SERV writes the code instead, as it does when
    // Dolphin doesn't answer; noServCode keeps SERV's budget for the rest.
    const noCode = this.noServCode && what === "code" && to === "serv" && (this.spent("dolphin") >= this.budget.dolphin || (this.cap !== null && this.spent("dolphin", agent) >= this.cap.dolphin));
    if (over || noCode) {
      note({ status: "refused", ms: 0, promptTokens: null, completionTokens: null });
      throw new Error(`suite: the ${to} budget is used up`);
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await this.realFetch(input, init);
    } catch (err) {
      note({ status: "error", ms: Date.now() - started, promptTokens: null, completionTokens: null });
      throw err;
    }
    const entry: LiveCall = { agent, to, what, status: res.status, ms: Date.now() - started, promptTokens: null, completionTokens: null };
    this.calls.push(entry);
    const list = this.recorded.get(agent) ?? [];
    this.recorded.set(agent, list);
    const kept: Recorded = { what, key, status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body: "" };
    list.push(kept);
    const note2 = (text: string) => {
      kept.body = text;
      entry.ms = Date.now() - started;
      const u = usageOf(text);
      entry.promptTokens = u.prompt;
      entry.completionTokens = u.completion;
    };
    // A stream is kept as it passes to the caller, which may stop reading
    // it part way; anything else is read to the end beside the caller.
    if (res.body && kept.contentType.includes("event-stream")) {
      const decoder = new TextDecoder();
      let text = "";
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctrl) {
          text += decoder.decode(chunk, { stream: true });
          note2(text);
          ctrl.enqueue(chunk);
        },
      });
      return new Response(res.body.pipeThrough(tap), { status: res.status, headers: res.headers });
    }
    this.pending.push(
      res
        .clone()
        .text()
        .then(note2)
        .catch(() => undefined),
    );
    return res;
  };

  async settled(): Promise<void> {
    await Promise.all(this.pending);
  }
}
