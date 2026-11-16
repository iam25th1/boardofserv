// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { servicesIn } from "../connections/catalog";
import { checkDefinition, type AgentDefinition } from "./definition";
import { FIXER_PROMPT, type FixVerdict } from "./fixer";
import { toCatalogVerdict } from "./heal";
import { repaired, wireToDefinition } from "./plan";
import { toCatalogTools, type RawStep } from "./planRepairs";
import { joinPlan } from "./planStages";
import { servicesPrompt } from "./servicesPrompt";

// Price and market data come through the catalog's CoinGecko entry (no
// key), never a raw fetch of a catalogued service's API: the planner, its
// repairs and the fixer all steer there.

// The regression suite's ETH watcher, as SERV planned it live: its price
// fetched from CoinGecko's API with web.fetch.
function recordedEth(): Record<string, unknown> {
  const recorded = JSON.parse(readFileSync(join(process.cwd(), "src/test/suite/recorded.json"), "utf8")) as Record<string, { what: string; body: string }[]>;
  const content = (r: { body: string }) => JSON.parse((JSON.parse(r.body) as { choices: { message: { content: string } }[] }).choices[0]!.message.content) as Record<string, unknown>;
  // Its last outline and each step's last details: the plan it settled on.
  const outline = content(recorded.eth!.filter((r) => r.what === "agent_outline").at(-1)!);
  const details = new Map<string, Record<string, unknown>>();
  for (const r of recorded.eth!.filter((x) => x.what === "agent_steps")) for (const st of (content(r).steps as Record<string, unknown>[]) ?? []) details.set(String(st.id), st);
  return joinPlan(outline, details);
}

describe("coin prices", () => {
  it("are CoinGecko's, whatever the maker calls them", () => {
    for (const said of ["Tell me when the ETH price drops below 2000 dollars.", "Watch the bitcoin price every hour", "Send me the market cap of solana each morning"]) expect(servicesIn(said), said).toContain("coingecko");
    expect(servicesPrompt(["coingecko"])).toContain("Prices and market data of coins and tokens (ETH, BTC, any other) come from coingecko.read");
  });

  it("are read with coingecko.read in the recorded ETH watcher's plan, with no new call to SERV", () => {
    const wire = recordedEth();
    const fetched = (wire.steps as RawStep[]).find((s) => (s.tools ?? []).includes("web.fetch"))!;
    expect(fetched.description).toContain("https://api.coingecko.com/");
    const c = checkDefinition(repaired(wireToDefinition(wire), { said: "Tell me when ETH drops below my target.", owner: "Tell me when ETH drops below my target." }));
    expect(c.ok, c.ok ? "" : c.errors.join("; ")).toBe(true);
    const d = (c as { definition: AgentDefinition }).definition;
    const step = d.steps.find((s) => s.id === fetched.id)!;
    expect(step.kind === "code" && step.tools).toEqual(["coingecko.read"]);
    expect(step.kind === "code" && step.description).toMatch(/Read CoinGecko with coingecko\.read, its tool here, never by fetching its address with web\.fetch\.$/);
    expect(d.steps.some((s) => s.kind === "code" && s.tools.includes("web.fetch"))).toBe(false);
  });

  it("reach a service with no typed read through service.request, named in services", () => {
    const steps: RawStep[] = [{ id: "pairs", title: "Read the pool", kind: "code", inputs: ["settings"], outputs: ["pairs"], tools: ["web.fetch"], description: "Fetch https://api.dexscreener.com/latest/dex/search?q= with the token in settings.token." }];
    expect(toCatalogTools(steps)).toEqual(["dexscreener"]);
    expect(steps[0]!.tools).toEqual(["service.request"]);
    expect(steps[0]!.description).toContain('Read DexScreener with service.request (connection "dexscreener")');
    // A page that isn't a service of the catalog stays a fetch.
    const page: RawStep[] = [{ id: "page", title: "Read the page", kind: "code", inputs: ["settings"], outputs: ["text"], tools: ["web.fetch"], description: "Fetch the product page in settings.product_url." }];
    expect(toCatalogTools(page)).toEqual([]);
    expect(page[0]!.tools).toEqual(["web.fetch"]);
  });
});

describe("the fixer", () => {
  // A plan made before the catalog steered it (an older draft): its price
  // still fetched from CoinGecko's API.
  const plan = (): AgentDefinition => {
    const wire = recordedEth();
    const before = (wire.steps as RawStep[]).find((s) => (s.tools ?? []).includes("web.fetch"))!;
    const c = checkDefinition(repaired(wireToDefinition(wire)));
    if (!c.ok) throw new Error(c.errors.join("; "));
    return { ...c.definition, steps: c.definition.steps.map((s) => (s.id === before.id && s.kind === "code" ? { ...s, tools: ["web.fetch"], description: before.description! } : s)) };
  };
  const verdict = (v: FixVerdict["verdict"]): FixVerdict => ({ verdict: v, step: null, why: "The sample's page doesn't match.", spec: "", change: "", sample: "Give a page for the price URL.", question: "", choices: [], lesson: "", kind: "other" });

  it("is told to steer a fetched service to its own tool", () => {
    expect(FIXER_PROMPT).toContain("A step that fetches a service of the catalog with web.fetch (CoinGecko's or GitHub's API, a price page for a coin) is plan_wrong");
  });

  it("steers there whatever it said: a new sample or a new brief would only fetch again", () => {
    const d = plan();
    const fetching = d.steps.find((s) => s.kind === "code" && s.tools.includes("web.fetch"))!;
    for (const v of ["test_wrong", "code_wrong"] as const) {
      const out = toCatalogVerdict(verdict(v), d, fetching.id);
      expect(out).toMatchObject({ verdict: "plan_wrong", step: fetching.id });
      expect(out.change).toBe(`Step "${fetching.id}" reads CoinGecko with coingecko.read instead of web.fetch, with what it reads (the coins, the repositories) from a setting. Nothing else changes.`);
    }
    // Only the maker can say: a question stays a question.
    expect(toCatalogVerdict(verdict("unclear"), d, fetching.id).verdict).toBe("unclear");
  });
});
