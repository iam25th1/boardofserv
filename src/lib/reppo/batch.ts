import "server-only";
import type { AgentDefinition } from "../agents/definition";
import type { AgentJob } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import { queueEval } from "./evals";
import { scrub } from "./redact";
import { budgetRoom, reppoSettings } from "./sampling";

// Reppo's second opinion on the one question about a run's held messages
// (agents/runtime/held.ts): one evaluation for the whole batch, asked for
// beside the wait, never instead of it, with the same redaction and caps as
// any second opinion. Reppo never sees a message's words or a link: each
// link is a label (L1, L2, ...) and what can be told of it without showing
// it (plain http, a link shortener, a bare IP address...). It is asked to
// name the links it finds risky by label, and those are flagged on their
// messages. The owner's answer is always the decision.

// A held message on its question: its words (an excerpt) and its links,
// each with its label for Reppo.
export interface HeldItem {
  text: string;
  links: { label: string; link: string; risky?: boolean }[];
}

const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rebrand.ly", "shorturl.at", "tiny.cc", "rb.gy", "t.ly", "s.id", "v.gd", "lnkd.in"]);
const SPAMMY = new Set(["top", "xyz", "click", "icu", "buzz", "gq", "tk", "ml", "cf", "ga", "work", "loan", "zip", "mov", "cam", "rest", "monster", "quest", "country", "stream", "download", "racing", "win", "bid", "party", "date", "faith", "review"]);
const LURES = /log-?in|sign-?in|verif|account|password|passcode|wallet|seed|claim|refund|prize|gift|bonus|airdrop|reward|unlock|confirm/i;

// What can be told of a link, address or contact without showing it.
export function linkFacts(link: string): string {
  const t = link.trim();
  if (/^[^\s@/:]+@[^\s@/]+\.[a-z]{2,}$/i.test(t)) return "an email address";
  if (/^0x[a-f0-9]{40}$/i.test(t)) return "a wallet address";
  if (/^\+?\d[\d ().-]{7,}\d$/.test(t)) return "a phone number";
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return "something like a link";
  }
  const host = u.hostname.toLowerCase();
  const facts: string[] = [];
  if (u.protocol === "http:") facts.push("plain http, not https");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) facts.push("a bare IP address instead of a name");
  if (host.split(".").some((l) => l.startsWith("xn--"))) facts.push("a look-alike (punycode) name");
  if (SHORTENERS.has(host.replace(/^www\./, ""))) facts.push("a link shortener that hides where it goes");
  if (SPAMMY.has(host.split(".").pop() ?? "")) facts.push("a top-level domain often used for spam");
  if (host.split(".").length >= 5) facts.push("many subdomains");
  if (u.username || u.password) facts.push("a name before an @ that can disguise the real site");
  if (u.port) facts.push("an unusual port");
  if (LURES.test(`${host} ${u.pathname} ${u.search}`)) facts.push("words like login, verify, claim or wallet in it");
  return `a web link: ${facts.length ? facts.join("; ") : "an ordinary web address"}`;
}

export function batchEvalInput(d: Pick<AgentDefinition, "name" | "job" | "actions">, items: HeldItem[], outside: boolean): string {
  const n = items.length;
  const sends = d.actions.filter((a) => a.tool === "telegram.send").map((a) => a.description);
  const lines = [
    `An automated agent has finished a run and wants to send the person who rents it ${n === 1 ? "a message" : `${n} messages`}. ${n === 1 ? "It waits" : "They wait"} for the person's yes because ${n === 1 ? "it carries" : "they carry"} links, addresses or contact details the person never gave the agent. Give one second opinion on ${n === 1 ? "it" : "them all"}: do they fit what the agent is for, and do the links look safe? The person decides; your opinion is shown beside the question.`,
    "The messages' words, personal details and the links themselves are left out on purpose: each link is shown only by a label (L1, L2 and so on) and what can be told of it without showing it. Don't mark it down for that.",
    'Begin your reason with one line naming the links you find risky by their labels, "Risky links: L2, L5." or "Risky links: none.", then say why in one sentence.',
    "",
    `The agent: ${d.name}`,
    `What the person rents it to do (its published purpose): ${d.job.does}`,
    `All it may ever do: ${d.actions.map((a) => a.description).join("; ") || "nothing but read and work things out"}`,
    `How it sends them: ${sends.join("; ") || "a message to the person"}`,
    ...(outside ? ["Some of what it acts on came from outside the person's own answers (a web page, a sheet, a form, a message or its memory)."] : []),
    "",
    ...items.map((m, i) => `Message ${i + 1}: ${m.links.map((l) => `${l.label} (${linkFacts(l.link)})`).join(", ") || "no link"}`),
  ];
  return scrub(lines.join("\n")).slice(0, 8_000);
}

// Asks for the one second opinion on a batch's question, when Reppo is on,
// second opinions are, and the day's credits have room: one evaluation,
// counted once. Never throws: the question goes out whatever happens here.
export async function requestBatchOpinion(rt: Runtime, o: { job: AgentJob; agentId: string; approvalId: string; definition: AgentDefinition; items: HeldItem[]; outside: boolean }): Promise<boolean> {
  try {
    const settings = reppoSettings();
    if (!rt.services.reppo || !settings.actionOpinions || !(await budgetRoom(rt, settings))) return false;
    const row = await queueEval(rt, {
      kind: "action",
      key: `action:${o.approvalId}`,
      agentId: o.agentId,
      versionId: o.job.versionId,
      installationId: o.job.installationId,
      jobId: o.job.id,
      approvalId: o.approvalId,
      taskType: "action",
      input: batchEvalInput(o.definition, o.items, o.outside),
    });
    return Boolean(row);
  } catch (err) {
    rt.log(`reppo: a second opinion on held messages wasn't asked for: ${err instanceof Error ? err.name : "unknown error"}`);
    return false;
  }
}

const RISKY = /risky links?\s*:\s*([^.\n]*)/i;
const RISKY_LINE = /risky links?\s*:\s*[^.\n]*[.\n]?\s*/i;

// The labels of the links Reppo called risky, from its reason's first line.
export function riskyLabels(reason: string | null | undefined): string[] {
  const m = reason ? RISKY.exec(reason) : null;
  return m ? [...new Set([...m[1]!.matchAll(/\bL(\d{1,3})\b/g)].map((x) => `L${x[1]}`))] : [];
}

// Its reason in one line: the first sentence after the risky links' line.
export function oneLine(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const rest = reason.replace(RISKY_LINE, "").replace(/\s+/g, " ").trim();
  const first = (/^(.+?[.!?])(?:\s|$)/.exec(rest)?.[1] ?? rest).trim();
  if (!first) return null;
  return first.length > 200 ? `${first.slice(0, 197).trimEnd()}...` : first;
}
