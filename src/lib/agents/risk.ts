import { spends, type AgentDefinition, type AgentStep, type ToolName } from "./definition";
import { RISKS, TOOLS, type Risk } from "./toolbox";
import type { SafetyDTO } from "../types";

// Risk levels for what an agent does, and what its renter allows it to do
// on its own. Every tool has a level in the toolbox's registry; an action
// that spends (a payment, or sheet rows with an amount) is money whatever
// its tool. Shared by the runtime (to gate) and the pages (to say).
//
// The platform's floor, which nobody can lower:
// - money needs the renter's yes above their auto limit (0 unless they
//   raise it), per call;
// - outbound to anyone but the renter's own linked chat always needs it
//   (today every outbound tool reaches only the renter, so this binds what
//   an outbound message carries: see untrusted.ts for links and contacts).
// A renter can raise any tool to "ask me first" in their settings.

export { RISKS, type Risk };

export const RISK_WORDS: Record<Risk, string> = {
  read: "looks things up",
  write: "changes your own data",
  outbound: "sends a message",
  money: "spends money",
};

export const riskRank = (r: Risk) => RISKS.indexOf(r);
export const atLeast = (r: Risk, floor: Risk) => riskRank(r) >= riskRank(floor);

// The level of one tool call in a step: the tool's, or money when the
// action it is taken for spends.
export function riskOf(d: Pick<AgentDefinition, "actions">, step: AgentStep | null, tool: ToolName): Risk {
  const action = step?.kind === "action" ? d.actions.find((a) => a.id === step.action && a.tool === tool) : d.actions.find((a) => a.tool === tool && spends(a));
  if (action && spends(action)) return "money";
  return TOOLS[tool].risk;
}

// Every tool an agent may use, once each: its actions' and its code steps'.
export function toolsOf(d: Pick<AgentDefinition, "actions" | "steps">): ToolName[] {
  const all = [...d.actions.map((a) => a.tool), ...d.steps.flatMap((s) => (s.kind === "code" ? s.tools : []))];
  return [...new Set(all)].sort((a, b) => riskRank(TOOLS[a].risk) - riskRank(TOOLS[b].risk) || a.localeCompare(b));
}

// The highest level a tool reaches in this agent (a sheet write that
// spends is money).
export function toolRisk(d: Pick<AgentDefinition, "actions">, tool: ToolName): Risk {
  return d.actions.some((a) => a.tool === tool && spends(a)) ? "money" : TOOLS[tool].risk;
}

// What the renter allows on their own installation.
export interface SafetyPolicy {
  // Tools that always ask first (raised by the renter; reads can't be).
  askFor: ToolName[];
  // Spending up to this much in USDC per call goes ahead without asking.
  autoSpendUsdc: number;
}

export const DEFAULT_POLICY: SafetyPolicy = { askFor: [], autoSpendUsdc: 0 };
export const MAX_AUTO_SPEND_USDC = 1000;

// A stored policy, cleaned: unknown tools and reads dropped, the auto
// limit kept within 0 and MAX_AUTO_SPEND_USDC.
export function readPolicy(raw: unknown): SafetyPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof SafetyPolicy, unknown>>;
  const askFor = Array.isArray(r.askFor) ? [...new Set(r.askFor.filter((t): t is ToolName => typeof t === "string" && t in TOOLS && TOOLS[t as ToolName].risk !== "read"))] : [];
  const n = typeof r.autoSpendUsdc === "number" && Number.isFinite(r.autoSpendUsdc) ? r.autoSpendUsdc : 0;
  return { askFor, autoSpendUsdc: Math.min(MAX_AUTO_SPEND_USDC, Math.max(0, n)) };
}

// Why this call must wait for the renter under the floor and their own
// settings, in plain words: none when it may go ahead. `amount` is what it
// spends, for money.
export function policyAsks(policy: SafetyPolicy, o: { tool: ToolName; risk: Risk; amount?: number | null; toOwner: boolean }): string[] {
  const why: string[] = [];
  if (o.risk === "money" && (o.amount ?? Infinity) > policy.autoSpendUsdc) {
    why.push(policy.autoSpendUsdc > 0 ? `It spends more than your auto limit of ${policy.autoSpendUsdc} USDC.` : "It spends money, and you approve every spend.");
  }
  if (o.risk === "outbound" && !o.toOwner) why.push("It sends to someone other than you.");
  if (policy.askFor.includes(o.tool) && o.risk !== "read") why.push(`You asked to approve it every time it ${RISK_WORDS[TOOLS[o.tool].risk]}.`);
  return why;
}

// Outbound tools whose only recipient is the renter: Telegram to their own
// linked chat (and the app's message box).
export const TO_OWNER_ONLY: readonly ToolName[] = ["telegram.send", "telegram.ask"];

// The renter's view of it.
export function safetyOf(d: Pick<AgentDefinition, "actions" | "steps">, policy: SafetyPolicy): SafetyDTO {
  return {
    tools: toolsOf(d).map((tool) => {
      const risk = toolRisk(d, tool);
      const floor =
        risk === "money"
          ? "Asks you before spending more than your auto limit."
          : tool === "telegram.ask"
            ? "Always waits for your answer."
            : risk === "read"
              ? null
              : risk === "outbound" && !TO_OWNER_ONLY.includes(tool)
                ? "Always asks you first."
                : null;
      return { tool, risk, does: TOOLS[tool].summary, floor, asks: policy.askFor.includes(tool), canRaise: risk !== "read" && risk !== "money" && tool !== "telegram.ask" };
    }),
    autoSpendUsdc: policy.autoSpendUsdc,
    maxAutoSpendUsdc: MAX_AUTO_SPEND_USDC,
  };
}
