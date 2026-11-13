import "server-only";
import { Script } from "node:vm";
import { completeJson, DOLPHIN_LABEL, modelConfig, type ChatMessage, type JsonResult, type ModelConfig, type Provider } from "../model";
import { ANSWER_LIMITS } from "../modelLimits";
import { ARGS_TOOLS, loopsOf, REASON_TOOL, type AgentDefinition, type CodeStepDef, type ToolName } from "./definition";
import { TOOLS } from "./toolbox";
import { toolTypes } from "./toolbox";
import type { StepCode } from "./types";
import { rulesText } from "./lessonRules";

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
const CODE_MAX_TOKENS = ANSWER_LIMITS.code;
const DEFAULT_CODE_TIMEOUT_MS = 240_000;
// A review isn't streamed: it gets a minute, not a reply's first-token wait.
const REVIEW_TIMEOUT_MS = 60_000;

export const CODE_PROMPT = [
  "You write one JavaScript function for one step of an automated agent. Reply with only the code, in one ```js block, nothing else.",
  "Write `async function run(input, tools)`. input holds the step's inputs by name; return an object with exactly the step's outputs by name.",
  "Call only the tools listed, always with await. Plain JavaScript (ES2020): no TypeScript, no imports, no require, no fetch, no console, no timers, no globals.",
  "Read only the inputs listed, as they are described: never invent input fields, flags or options the step doesn't name (no input.skip, input.nothingToDo or input.cancelled), and never skip what the step says to do.",
  "Keep it short, and handle missing or odd values without throwing where you can.",
  "When serv.reason is listed, every judgement or piece of writing the step makes (a score and its reasons, a reply, a line for the day) comes from SERV: call tools.serv.reason({ task, data, answer }) for it (once per item), and return what SERV answered. Never work it out yourself with word counts, lengths, keyword lists or canned text.",
  "Text it writes for people never uses em dashes: use a colon or a comma.",
  "A sheet's rows (sheets.read) are objects keyed by the sheet's own column headers, exactly as written (row.Name, row[\"Due date\"]), plus _row, the row's number: read each column by its header as the step names it, never lower-cased or renamed.",
  "Dates and times are the owner's: new Date() and its local methods (getDate, getHours, toLocaleDateString) are in their time zone. For today's date use those, never toISOString().slice(0, 10), which is UTC.",
].join("\n");

// The review's rules go in the request, not the system message: live, a
// review whose reason restated a system message's rules was cut off by
// SERV's gateway ("I can't share that.") two times in five. An approval
// gives no reason at all, so there is nothing to restate.
export const REVIEW_SYSTEM = "You review JavaScript code for one step of an automated agent. Answer with JSON in the given schema.";

export const REVIEW_PROMPT = [
  "Review this code before it is saved and run in a sandbox.",
  "Approve only if all of these hold: it does what the step says, reading only its inputs and returning an object whose keys are exactly its outputs (never a bare value); a message the step makes for the owner may be the text itself or telegram.send's arguments { text }, either is right; an output an action takes as its tool's arguments has exactly that shape; it calls only the tools listed (the list is exactly what the code calls, so a tool the step's words mention but the code doesn't need is not listed); it does nothing risky (no reaching for the network, files, timers or globals, no endless loops or huge allocations, nothing sent anywhere except through the listed tools).",
  "When serv.reason is listed, the step's judgement or writing must come from tools.serv.reason, not from rules of thumb, word counts, keyword lists or canned text in the code: reject code that works it out itself.",
  "Approving, leave the reason empty. Rejecting, say in one or two plain sentences, in your own words, what to change in this code. Never use em dashes.",
].join(" ");

export const REVIEW_SCHEMA = {
  name: "code_review",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason"],
    properties: {
      verdict: { type: "string", enum: ["approve", "reject"] },
      reason: { type: "string", description: "rejecting: what to change in this code, one or two plain sentences; approving: empty" },
    },
  },
};

const RULE_AS: Record<string, string> = { number: "a number", usdc: "a number of USDC", boolean: "true or false", list: "an array of strings", text: "text" };

// What Dolphin is told about one step: what it must do, what its inputs
// hold, what it returns and the declarations of the tools it may call.
export function codeRequest(step: CodeStepDef, d: AgentDefinition): string {
  // inner: the value as one pass of a loop made it (a loop may gather it
  // under the same name).
  const holds = (name: string, inner = false): string => {
    if (name === "settings") return `the renter's setup: { ${d.settings.map((s) => `${s.key}: ${s.type} (${s.label}; ${s.help})`).join(", ") || "nothing"} }`;
    if (name === "rules") return `the renter's limits: { ${d.rules.map((r) => `${r.key}: ${RULE_AS[r.type]} (${r.label})`).join(", ") || "nothing"} }`;
    if (name === "memory") return `what was kept from the last job: { ${d.memory.map((m) => `${m.key}: ${m.type}`).join(", ") || "nothing"} }`;
    if (name === "trigger") return "what woke the agent up (null on a schedule)";
    // A loop's item, and what it gathered from every pass.
    const loop = d.steps.find((s) => s.kind === "loop" && (s.item === name || (!inner && s.outputs.includes(name))));
    if (loop?.kind === "loop" && loop.item === name) {
      const setting = !loop.inputs.includes(loop.over) ? d.settings.find((x) => x.key === loop.over) : undefined;
      return `one item of ${loop.over} (the step "${loop.title}" goes through them one at a time), which is ${setting ? `the renter's answer to "${setting.label}" (a ${setting.type})` : holds(loop.over)}`;
    }
    if (loop?.kind === "loop") {
      const g = loop.gather.find((x) => x.into === name)!;
      return `a list with one entry per item of ${loop.over}, in order (gathered by the step "${loop.title}" from every pass): each entry is what ${g.from} was in that pass, ${holds(g.from, true)}`;
    }
    const from = d.steps.find((s) => s.outputs.includes(name) && !(inner && s.kind === "loop"));
    // A decision over a list's verdicts: exactly their shape.
    if (from?.kind === "decision" && from.each && from.outputs[0] === name) {
      return `the verdicts of the step "${from.title}", one per item of ${from.each} in the same order: Array<{ item: number (the item's place in ${from.each}, from 0), outcome: ${from.outcomes.map((o) => `"${o.id}"`).join(" | ")}, label: string, reason: string }>`;
    }
    // A decision inside a loop gives its verdict for the item.
    if (from?.kind === "decision" && from.outputs[0] === name && loopsOf(d).inside.get(from.id)) {
      return `the verdict of the step "${from.title}" (${from.prompt}): { outcome: ${from.outcomes.map((o) => `"${o.id}"`).join(" | ")}, label: string, reason: string }`;
    }
    const shaped = from?.shapes?.[name] ? `, shaped ${from.shapes[name]}` : "";
    return from ? `from the step "${from.title}"${from.kind === "code" ? `: ${from.description}` : ""}${shaped}` : "a value from an earlier step";
  };
  const shapes = argShapes(step, d);
  return [
    `This agent: ${d.job.does}`,
    `Step: ${step.title}`,
    `What it must do: ${step.description}`,
    "",
    "input:",
    ...(step.inputs.length ? step.inputs.map((i) => `- ${i}: ${holds(i)}`) : ["- (nothing)"]),
    "",
    `Return: { ${step.outputs.join(", ") || "nothing"} }`,
    ...step.outputs.filter((o) => step.shapes?.[o]).map((o) => `- ${o} is shaped ${step.shapes![o]}: exactly those fields, so the steps after it can read them.`),
    ...shapes,
    "",
    "Tools it may call:",
    toolTypes(step.tools),
  ].join("\n");
}

// An output an action takes as its tool's arguments must be exactly those:
// what Dolphin is told, and what the review checks.
export function argShapes(step: CodeStepDef, d: AgentDefinition): string[] {
  return step.outputs.flatMap((o) => {
    const user = d.steps.find((s) => s.kind === "action" && s.inputs[0] === o);
    const action = user?.kind === "action" ? d.actions.find((a) => a.id === user.action) : undefined;
    if (!action || !ARGS_TOOLS.includes(action.tool)) return [];
    const sig = TOOLS[action.tool].signature;
    return [`- ${o} must be exactly the arguments of ${sig.slice(0, sig.lastIndexOf("): Promise") + 1)}, which the step "${user!.title}" calls with it.`];
  });
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
  if (step.tools.includes(REASON_TOOL) && !used.includes(REASON_TOOL)) return "It never asks SERV (tools.serv.reason), so its judgement or writing would be a guess: ask SERV for it and use the answer.";
  return null;
}

// The tools a function calls, each once, as tools.<group>.<name>(...).
export function toolsCalled(source: string): string[] {
  return [...new Set([...source.matchAll(/\btools\s*\.\s*([a-z]+)\s*\.\s*([a-zA-Z]+)/g)].map((m) => `${m[1]}.${m[2]}`))];
}

// Tools that only look: listing one a step's code calls changes nothing it
// may do, so the list takes it rather than the code being sent back.
const LOOKS: readonly ToolName[] = ["sheets.read", "web.fetch", "web.search", "memory.get", "typeform.read", REASON_TOOL];

// The step's tool list made to match its code: a listed tool the code never
// calls comes off (SERV's review held steps for that), and a tool that only
// looks, called but not listed, goes on. A tool that changes something,
// called but not listed, stays off: the code is sent back for it.
// SERV's reasoning stays listed even when the code skips it: the check
// sends that code back rather than let the step guess.
export function fitTools(step: CodeStepDef, source: string): ToolName[] {
  const called = toolsCalled(source);
  const kept = step.tools.filter((t) => called.includes(t) || t === REASON_TOOL);
  const looks = called.filter((t): t is ToolName => (LOOKS as readonly string[]).includes(t) && !kept.includes(t as ToolName));
  return [...kept, ...looks];
}

const sameTools = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t) => b.includes(t));

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
export async function reviewCode(source: string, step: CodeStepDef, serv: ModelConfig, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; definition?: AgentDefinition } = {}): Promise<Review | null> {
  const shapes = opts.definition ? argShapes(step, opts.definition) : [];
  const messages: ChatMessage[] = [
    { role: "system", content: REVIEW_SYSTEM },
    {
      role: "user",
      content: [
        REVIEW_PROMPT,
        "",
        `Step: ${step.title}`,
        `What it must do: ${step.description}`,
        `Inputs: ${step.inputs.join(", ") || "none"}`,
        `Outputs: ${step.outputs.join(", ") || "none"}`,
        ...shapes,
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
  const result = await completeJson(messages, { config, purpose: "code_review", schema: REVIEW_SCHEMA, signal: opts.signal ?? new AbortController().signal, fetchImpl: opts.fetchImpl });
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
  // Whether a review fits the platform's own model budget today (unset:
  // always). Without room it waits, as when SERV can't answer.
  reviewRoom?: () => Promise<boolean>;
}

// Write one code step: Dolphin writes, the checks and SERV review, a
// rejection goes back with its reason. Ends approved, or needing the
// maker's attention with the last reason and the last code.
export async function writeStep(
  step: CodeStepDef,
  d: AgentDefinition,
  spec: string,
  // writer: "serv" has SERV write it from the start ("Fix this" on a held
  // step); without Dolphin set up, SERV writes it too.
  // hint: why an earlier version of this step didn't pass (the fixer
  // sends it with the step's corrected brief), so it isn't written that
  // way again. rounds: how many tries before it is held.
  // lessons: rules learned from earlier builds (lessons.ts).
  opts: { dolphin: Provider | null; serv: ModelConfig; hooks: WriteHooks; fetchImpl?: typeof fetch; signal?: AbortSignal; writer?: "dolphin" | "serv"; hint?: string | null; rounds?: number; lessons?: string[] },
): Promise<StepCode> {
  const conversation: ChatMessage[] = [
    { role: "system", content: `${CODE_PROMPT}${rulesText(opts.lessons)}` },
    { role: "user", content: opts.hint ? `${codeRequest(step, d)}\n\nAn earlier version of this step didn't pass: ${opts.hint}\nWrite it so that can't happen again.` : codeRequest(step, d) },
  ];
  const maxRounds = opts.rounds ?? MAX_CODE_ROUNDS;
  let source: string | null = null;
  let note = "";
  let rounds = 0;
  let writer: "dolphin" | "serv" = opts.writer ?? (opts.dolphin ? "dolphin" : "serv");
  let dolphinFailures = 0;
  // One draft: Dolphin's, or SERV's once Dolphin hasn't answered twice.
  const write = async (round: number): Promise<TextResult> => {
    for (;;) {
      const w =
        writer === "serv" || !opts.dolphin
          ? await writeWithServ(opts.serv, conversation, { fetchImpl: opts.fetchImpl, signal: opts.signal })
          : await writeWithDolphin(opts.dolphin, conversation, { thinking: round > 1, fetchImpl: opts.fetchImpl, signal: opts.signal });
      await opts.hooks.record("agent_code", w);
      if (w.content || writer === "serv" || opts.signal?.aborted) return w;
      dolphinFailures += 1;
      if (dolphinFailures >= DOLPHIN_TRIES) writer = "serv";
    }
  };
  for (let round = 1; round <= maxRounds; round++) {
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
    // The list is made to match the code before anything checks it.
    const tools = fitTools(step, code);
    const fitted = { ...step, tools };
    const problem = checkCode(code, fitted);
    if (problem) {
      note = problem;
    } else {
      await opts.hooks.progress("reviewing", round);
      if (opts.hooks.reviewRoom && !(await opts.hooks.reviewRoom())) {
        note = "SERV couldn't review it just now.";
        break;
      }
      const review = await reviewCode(code, fitted, opts.serv, { fetchImpl: opts.fetchImpl, signal: opts.signal, definition: d });
      if (review) await opts.hooks.record("agent_review", review.result);
      if (!review) {
        note = "SERV couldn't review it just now.";
        break;
      }
      if (review.approved) {
        return { spec, status: "approved", source: code, rounds: round, note: review.reason || null, ...(writer === "serv" ? { writer } : {}), ...(sameTools(tools, step.tools) ? {} : { tools }), updatedAt: new Date().toISOString() };
      }
      note = review.reason || "SERV rejected it.";
    }
    conversation.push(
      { role: "assistant", content: "```js\n" + code + "\n```" },
      { role: "user", content: `It was rejected: ${note}\nWrite the whole function again with that fixed.` },
    );
  }
  return { spec, status: "needs_attention", source, rounds, note, ...(writer === "serv" ? { writer } : {}), updatedAt: new Date().toISOString() };
}
