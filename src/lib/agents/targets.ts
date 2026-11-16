import type { AgentDefinition, CodeStepDef } from "./definition";
import { typedRead } from "../connections/reads";

// What an agent works on and who it tells are the owner's to say, as
// settings and rules (definition.ts), never written into its code: the
// repositories it checks, the addresses and links it reads, the forms,
// the wallets and recipients, the numbers it compares against. Code that
// embeds one would do the same thing for every owner, whatever they
// answered (the live GitHub verifier checked octocat/Hello-World, which
// answers 404, for everyone). A step's code with one fails its check, and
// goes back to be written again reading the setting instead; it heals as a
// code problem.

export interface Target {
  // What it wrote, in words: the repository "octocat/Hello-World".
  what: string;
  // Where it should come from: settings.repos (Repositories).
  from: string | null;
}

// The code's strings, without its comments.
function strings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  return [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]!);
}

const MIME = /^(?:text|application|image|audio|video|multipart|font)\//i;
const REPO = /^[A-Za-z0-9][\w.-]{0,38}\/[\w.-]{1,100}$/;
const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
// A key that names who or what it works on, with a value written in.
const TARGET_KEY = /\b(owner|repo|repos|repository|repositories|url|link|address|wallet|email|to|recipient|recipients|channel|chat_id|form|form_id|coin|coins|ids|base|table|database)\s*:\s*(\[\s*)?(["'`])([^"'`$\n]{2,200})\3/gi;
// A number it compares a score, price or limit against.
const THRESHOLD = /\b([\w$.]*(?:score|quality|threshold|price|target|limit|minimum|maximum|percent)[\w$]*)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)\b|\b(\d+(?:\.\d+)?)\s*(>=|<=|>|<)\s*([\w$.]*(?:score|quality|threshold|price|target|limit|minimum|maximum|percent)[\w$]*)/gi;

// The setting or rule a value should come from: the one whose words or
// answer match it, else the one most like what it is.
function sourceOf(d: AgentDefinition | null | undefined, value: string, kind: "repo" | "address" | "number" | "other"): string | null {
  if (!d) return null;
  const given = d.settings.find((s) => s.given && s.given.toLowerCase().includes(value.toLowerCase()));
  if (given) return `settings.${given.key} (${given.label})`;
  const rule = d.rules.find((r) => r.value === value);
  if (rule) return `rules.${rule.key} (${rule.label})`;
  const words = kind === "repo" ? /repo|repositor|project/i : kind === "address" ? /url|link|address|page|feed|site|webhook|wallet|email|recipient/i : kind === "number" ? /threshold|min|max|target|limit|score|price/i : /./;
  const setting = d.settings.find((s) => words.test(`${s.key} ${s.label}`));
  if (setting) return `settings.${setting.key} (${setting.label})`;
  const r = kind === "number" ? d.rules.find((x) => words.test(`${x.key} ${x.label}`)) : undefined;
  if (r) return `rules.${r.key} (${r.label})`;
  // The only setting it has that could hold it.
  const only = d.settings.filter((s) => s.type !== "boolean" && s.type !== "sheet");
  return kind !== "number" && only.length === 1 ? `settings.${only[0]!.key} (${only[0]!.label})` : null;
}

// The first target written into a step's code, or null.
export function writtenTarget(source: string, step: Pick<CodeStepDef, "tools">, d?: AgentDefinition | null): Target | null {
  // It reaches outside: a page, a service, a payee. An address is a
  // target only where it fetches one (a link it writes into a message is
  // made from its data).
  const fetches = step.tools.some((t) => t === "web.fetch" || t === "service.request" || t === "service.send" || t === "wallet.pay" || typedRead(t));
  const fetchesPages = step.tools.some((t) => t === "web.fetch" || t === "service.request");
  for (const s of strings(source)) {
    const text = s.trim();
    // An address: a whole one, or one it fetches whose host is written in.
    const url = /\bhttps?:\/\/[^\s"'`]+/i.exec(text)?.[0];
    if (url && (!text.includes("${") || fetchesPages)) return { what: `the address "${url.slice(0, 80)}"`, from: sourceOf(d, url, /\/repos\/|github|gitlab/i.test(url) ? "repo" : "address") };
    if (REPO.test(text) && !MIME.test(text) && !/^\d+\/\d+$/.test(text) && !/^(?:and|or|n|y|yes|no)\/(?:or|and|a|n|no)$/i.test(text)) return { what: `the repository "${text}"`, from: sourceOf(d, text, "repo") };
    if (EMAIL.test(text)) return { what: `the email address "${text}"`, from: sourceOf(d, text, "address") };
    if (WALLET.test(text)) return { what: `the wallet "${text}"`, from: sourceOf(d, text, "address") };
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  for (const m of code.matchAll(TARGET_KEY)) {
    const value = m[4]!.trim();
    // A field it writes into a result ({ status: "open" }) is no target:
    // only who or what it reaches.
    if (/^(?:to|base|table|ids)$/i.test(m[1]!) && !fetches) continue;
    return { what: `${m[1]} "${value.slice(0, 80)}"`, from: sourceOf(d, value, /repo/i.test(m[1]!) || /owner/i.test(m[1]!) ? "repo" : "other") };
  }
  for (const m of code.matchAll(THRESHOLD)) {
    const n = m[3] ?? m[4]!;
    if (Number(n) === 0 || Number(n) === 1) continue;
    return { what: `the number ${n} it compares ${m[1] ?? m[6]} against`, from: sourceOf(d, n, "number") };
  }
  return null;
}

// Why the check fails, for Dolphin and for the fixer.
export function targetProblem(t: Target, readsSettings: boolean): string {
  const from = t.from ? `read it from ${t.from}` : "read it from the settings or rules the owner answers (add one if none holds it)";
  return `It writes ${t.what} into the code, so every owner would get the same one whatever they answered: ${from}${readsSettings ? "" : ", which this step now reads"}.`;
}
