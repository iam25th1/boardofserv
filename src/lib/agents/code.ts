import "server-only";
import { Script } from "node:vm";
import { completeJson, DOLPHIN_LABEL, modelConfig, type ChatMessage, type JsonResult, type ModelConfig, type Provider } from "../model";
import { ARGS_TOOLS, type AgentDefinition, type CodeStepDef } from "./definition";
import { TOOLS } from "./toolbox";
import { toolTypes } from "./toolbox";
import type { StepCode } from "./types";

// Code writing and review. Dolphin writes each code step as
// `async function run(input, tools)` against the toolbox's declarations.
// When Dolphin fails or times out twice on the same step, SERV writes that
// step instead (and is marked as its writer); either way SERV reviews the
// code in a call of its own.
// Before it is kept, the code passes plain checks (it parses, it names only
// its step's tools, it reaches for nothing outside the sandbox) and then
// SERV's review: does it do what the step says, touch only the declared
// tools, and do nothing risky. A rejection goes back to Dolphin with the
// reason, up to three rounds; after that the step needs the maker's
// attention. The code is stored with the version and only the maker's own
// builder ever shows it.
//
// Dolphin's settings come from recon on its API: max_tokens 4000, and its
// reasoning switched off for the first draft (chat_template_kwargs
// { thinking: false }, which it accepts though its docs don't list it), on
// for a rewrite after a rejection. If Dolphin ever refuses that field, the
// call is made again without it.

export const MAX_CODE_ROUNDS = 3;
const CODE_MAX_TOKENS = 4000;
const DEFAULT_CODE_TIMEOUT_MS = 240_000;
const REVIEW_MAX_TOKENS = 300;
// A review isn't streamed: it gets a minute, not a reply's first-token wait.
const REVIEW_TIMEOUT_MS = 60_000;

export const CODE_PROMPT = [
  "You write one JavaScript function for one step of an automated agent. Reply with only the code, in one ```js block, nothing else.",
  "Write `async function run(input, tools)`. input holds the step's inputs by name; return an object with exactly the step's outputs by name.",
  "Call only the tools listed, always with await. Plain JavaScript (ES2020): no TypeScript, no imports, no require, no fetch, no console, no timers, no globals.",
  "Keep it short, and handle missing or odd values without throwing where you can.",
  "Text it writes for people never uses em dashes: use a colon or a comma.",
].join("\n");

export const REVIEW_PROMPT = [
  "You review JavaScript written for one step of an agent, before it is saved and run in a sandbox.",
  "Approve only if all of these hold: it does what the step says, reading only its inputs and returning exactly its outputs; it calls only the tools listed; it does nothing risky (no reaching for the network, files, timers or globals, no endless loops or huge allocations, nothing sent anywhere except through the listed tools).",
  "If you reject it, say in one or two plain sentences what to change. Never use em dashes.",
].join(" ");

export const REVIEW_SCHEMA = {
  name: "code_review",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason"],
    properties: {
      verdict: { type: "string", enum: ["approve", "reject"] },
      reason: { type: "string", description: "why, in one or two plain sentences" },
    },
  },
};

const RULE_AS: Record<string, string> = { number: "a number", usdc: "a number of USDC", boolean: "true or false", list: "an array of strings", text: "text" };

// What Dolphin is told about one step: what it must do, what its inputs
// hold, what it returns and the declarations of the tools it may call.
export function codeRequest(step: CodeStepDef, d: AgentDefinition): string {
  const holds = (name: string): string => {
    if (name === "settings") return `the renter's setup: { ${d.settings.map((s) => `${s.key}: ${s.type} (${s.label}; ${s.help})`).join(", ") || "nothing"} }`;
    if (name === "rules") return `the renter's limits: { ${d.rules.map((r) => `${r.key}: ${RULE_AS[r.type]} (${r.label})`).join(", ") || "nothing"} }`;
    if (name === "memory") return `what was kept from the last job: { ${d.memory.map((m) => `${m.key}: ${m.type}`).join(", ") || "nothing"} }`;
    if (name === "trigger") return "what woke the agent up (null on a schedule)";
    const from = d.steps.find((s) => s.outputs.includes(name));
    return from ? `from the step "${from.title}"${from.kind === "code" ? `: ${from.description}` : ""}` : "a value from an earlier step";
  };
  // An output an action takes as its tool's arguments must be exactly those.
  const shapes = step.outputs.flatMap((o) => {
    const user = d.steps.find((s) => s.kind === "action" && s.inputs[0] === o);
    const action = user?.kind === "action" ? d.actions.find((a) => a.id === user.action) : undefined;
    if (!action || !ARGS_TOOLS.includes(action.tool)) return [];
    const sig = TOOLS[action.tool].signature;
    return [`- ${o} must be exactly the arguments of ${sig.slice(0, sig.lastIndexOf("): Promise") + 1)}, which the step "${user!.title}" calls with it.`];
  });
  return [
    `This agent: ${d.job.does}`,
    `Step: ${step.title}`,
    `What it must do: ${step.description}`,
    "",
    "input:",
    ...(step.inputs.length ? step.inputs.map((i) => `- ${i}: ${holds(i)}`) : ["- (nothing)"]),
    "",
    `Return: { ${step.outputs.join(", ") || "nothing"} }`,
    ...shapes,
    "",
    "Tools it may call:",
    toolTypes(step.tools),
  ].join("\n");
}

// The function in Dolphin's answer: the first fenced block, or the whole
// answer when it is bare code.
export function extractCode(content: string): string | null {
  const fenced = /```(?:js|javascript|ts|typescript)?[^\n]*\n([\s\S]*?)```/i.exec(content)?.[1];
  const code = (fenced ?? (/\basync\s+function\s+run\s*\(/.test(content) ? content : "")).trim();
  return code || null;
}

const REACHES = [
  [/\brequire\s*\(/, "it calls require"],
  [/\bimport\s*\(|^\s*import\s/m, "it imports a module"],
  // The global fetch, not the web.fetch tool (tools.web.fetch).
  [/(?<!\.\s*)\bfetch\s*\(/, "it calls fetch"],
  [/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/, "it reaches for the network"],
  [/\b(?:process|globalThis|window|self|global)\s*[.[]/, "it reaches for globals"],
  [/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/, "it builds code at run time"],
  [/__proto__|\.constructor\b|\bReflect\.|\bProxy\b/, "it plays with prototypes"],
  [/\bset(?:Timeout|Interval|Immediate)\s*\(/, "it uses timers"],
] as const;

// The plain checks, before SERV sees it: null when it passes, else why not.
export function checkCode(source: string, step: CodeStepDef): string | null {
  try {
    // Parsed, never run: node:vm compiles the text without executing it.
    new Script(`(async () => {\n${source}\n})`);
  } catch (err) {
    return `It doesn't parse: ${err instanceof Error ? err.message : "syntax error"}.`;
  }
  if (!/\basync\s+function\s+run\s*\(/.test(source)) return "It doesn't define async function run(input, tools).";
  for (const [pattern, why] of REACHES) if (pattern.test(source)) return `It isn't allowed: ${why}.`;
  if (/\btools\s*\[/.test(source)) return "It picks tools by a computed name; call each tool by its own name.";
  const used = [...source.matchAll(/\btools\s*\.\s*([a-z]+)\s*\.\s*([a-zA-Z]+)/g)].map((m) => `${m[1]}.${m[2]}`);
  const stray = [...new Set(used.filter((u) => !(step.tools as readonly string[]).includes(u)))];
  if (stray.length) return `It calls ${stray.join(", ")}, which this step may not use (allowed: ${step.tools.join(", ") || "none"}).`;
  return null;
}

// Dolphin not answering (failing or timing out) this many times on one
// step hands its writing to SERV.
export const DOLPHIN_TRIES = 2;
const SERV_CODE_TIMEOUT_MS = 120_000;

export interface TextResult {
  content: string | null;
  provider: "dolphin" | "serv";
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalMs: number;
  outcome: "ok" | "failed";
  status: number | null;
}

// Dolphin, from the environment only: never anyone's own key.
export function dolphinProvider(env: Record<string, string | undefined> = process.env): Provider | null {
  return modelConfig(env).providers.find((p) => p.id === "dolphin") ?? null;
}

// One Dolphin call for code: a plain completion, not streamed.
export async function writeWithDolphin(
  dolphin: Provider,
  messages: ChatMessage[],
  opts: { thinking: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<TextResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const t = Number(process.env.DOLPHIN_CODE_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(t) && t > 0 ? t : DEFAULT_CODE_TIMEOUT_MS;
  const started = Date.now();
  const once = async (withSwitch: boolean): Promise<{ res: Response | null; body: unknown }> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetchImpl(`${dolphin.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${dolphin.apiKey}` },
        body: JSON.stringify({
          model: dolphin.model,
          messages,
          max_tokens: CODE_MAX_TOKENS,
          stream: false,
          ...(withSwitch ? { chat_template_kwargs: { thinking: opts.thinking } } : {}),
        }),
        signal: ctl.signal,
      });
      return { res, body: res.ok ? await res.json().catch(() => null) : null };
    } catch {
      return { res: null, body: null };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };
  let { res, body } = await once(true);
  // The switch isn't in Dolphin's docs: if it is ever refused, go without.
  if (res?.status === 400) ({ res, body } = await once(false));
  const b = body as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
  const content = b?.choices?.[0]?.message?.content ?? null;
  return {
    content,
    provider: "dolphin",
    model: dolphin.model,
    promptTokens: b?.usage?.prompt_tokens ?? null,
    completionTokens: b?.usage?.completion_tokens ?? null,
    totalMs: Date.now() - started,
    outcome: content ? "ok" : "failed",
    status: res?.status ?? null,
  };
}

// SERV writing a step's code, when Dolphin couldn't: the same messages, a
// plain completion, not streamed.
export async function writeWithServ(serv: ModelConfig, messages: ChatMessage[], opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<TextResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const p = serv.providers.find((x) => x.id === "serv");
  const started = Date.now();
  const failed = (status: number | null): TextResult => ({ content: null, provider: "serv", model: p?.model ?? null, promptTokens: null, completionTokens: null, totalMs: Date.now() - started, outcome: "failed", status });
  if (!p) return failed(null);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SERV_CODE_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: p.model, messages, max_tokens: CODE_MAX_TOKENS, stream: false }),
      signal: ctl.signal,
    });
    if (!res.ok) return failed(res.status);
    const b = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    const content = b?.choices?.[0]?.message?.content ?? null;
    return { content, provider: "serv", model: p.model, promptTokens: b?.usage?.prompt_tokens ?? null, completionTokens: b?.usage?.completion_tokens ?? null, totalMs: Date.now() - started, outcome: content ? "ok" : "failed", status: res.status };
  } catch {
    return failed(null);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export interface Review {
  approved: boolean;
  reason: string;
  result: JsonResult;
}

// SERV's review of one function. A review that couldn't be made is not an
// approval.
export async function reviewCode(source: string, step: CodeStepDef, serv: ModelConfig, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<Review | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: REVIEW_PROMPT },
    {
      role: "user",
      content: [
        `Step: ${step.title}`,
        `What it must do: ${step.description}`,
        `Inputs: ${step.inputs.join(", ") || "none"}`,
        `Outputs: ${step.outputs.join(", ") || "none"}`,
        "Tools listed:",
        toolTypes(step.tools),
        "",
        "The code:",
        "```js",
        source,
        "```",
      ].join("\n"),
    },
  ];
  const config = { ...serv, firstTokenTimeoutMs: Math.max(serv.firstTokenTimeoutMs, REVIEW_TIMEOUT_MS) };
  const result = await completeJson(messages, { config, schema: REVIEW_SCHEMA, maxTokens: REVIEW_MAX_TOKENS, signal: opts.signal ?? new AbortController().signal, fetchImpl: opts.fetchImpl });
  if (!result.content) return null;
  try {
    const parsed = JSON.parse(result.content) as { verdict?: string; reason?: string };
    if (parsed.verdict !== "approve" && parsed.verdict !== "reject") return null;
    return { approved: parsed.verdict === "approve", reason: (parsed.reason ?? "").trim().slice(0, 500), result };
  } catch {
    return null;
  }
}

export interface WriteHooks {
  // Where the step stands, for the builder while it waits.
  progress: (status: "writing" | "reviewing", round: number) => Promise<void>;
  // Every model call, for the usage records.
  record: (kind: "agent_code" | "agent_review", call: TextResult | JsonResult) => Promise<void>;
}

// Write one code step: Dolphin writes, the checks and SERV review, a
// rejection goes back with its reason. Ends approved, or needing the
// maker's attention with the last reason and the last code.
export async function writeStep(
  step: CodeStepDef,
  d: AgentDefinition,
  spec: string,
  opts: { dolphin: Provider; serv: ModelConfig; hooks: WriteHooks; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<StepCode> {
  const conversation: ChatMessage[] = [
    { role: "system", content: CODE_PROMPT },
    { role: "user", content: codeRequest(step, d) },
  ];
  let source: string | null = null;
  let note = "";
  let rounds = 0;
  let writer = "dolphin" as "dolphin" | "serv";
  let dolphinFailures = 0;
  // One draft: Dolphin's, or SERV's once Dolphin hasn't answered twice.
  const write = async (round: number): Promise<TextResult> => {
    for (;;) {
      const w =
        writer === "serv"
          ? await writeWithServ(opts.serv, conversation, { fetchImpl: opts.fetchImpl, signal: opts.signal })
          : await writeWithDolphin(opts.dolphin, conversation, { thinking: round > 1, fetchImpl: opts.fetchImpl, signal: opts.signal });
      await opts.hooks.record("agent_code", w);
      if (w.content || writer === "serv" || opts.signal?.aborted) return w;
      dolphinFailures += 1;
      if (dolphinFailures >= DOLPHIN_TRIES) writer = "serv";
    }
  };
  for (let round = 1; round <= MAX_CODE_ROUNDS; round++) {
    rounds = round;
    await opts.hooks.progress("writing", round);
    const written = await write(round);
    const code = written.content ? extractCode(written.content) : null;
    if (!code) {
      note = written.content ? "No code came back." : writer === "serv" ? `${DOLPHIN_LABEL} didn't answer twice, and SERV didn't either.` : `${DOLPHIN_LABEL} didn't answer.`;
      if (!written.content) break;
      conversation.push({ role: "assistant", content: written.content.slice(0, 8000) }, { role: "user", content: "Reply with the function in one ```js block." });
      continue;
    }
    source = code;
    const problem = checkCode(code, step);
    if (problem) {
      note = problem;
    } else {
      await opts.hooks.progress("reviewing", round);
      const review = await reviewCode(code, step, opts.serv, { fetchImpl: opts.fetchImpl, signal: opts.signal });
      if (review) await opts.hooks.record("agent_review", review.result);
      if (!review) {
        note = "SERV couldn't review it just now.";
        break;
      }
      if (review.approved) return { spec, status: "approved", source: code, rounds: round, note: review.reason || null, ...(writer === "serv" ? { writer } : {}), updatedAt: new Date().toISOString() };
      note = review.reason || "SERV rejected it.";
    }
    conversation.push(
      { role: "assistant", content: "```js\n" + code + "\n```" },
      { role: "user", content: `It was rejected: ${note}\nWrite the whole function again with that fixed.` },
    );
  }
  return { spec, status: "needs_attention", source, rounds, note, ...(writer === "serv" ? { writer } : {}), updatedAt: new Date().toISOString() };
}
