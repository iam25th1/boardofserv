// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig, type Provider } from "@/lib/model";
import { servOnly } from "./build";
import { checkCode, fitInputs, writeStep } from "./code";
import { checkDefinition, codeSpec, type AgentDefinition, type CodeStepDef } from "./definition";
import { writtenTarget } from "./targets";

// What an agent works on and who it tells are settings and rules, never
// written into its code: code with one fails its check, and is written
// again reading the setting.

const plan = (o: Partial<AgentDefinition> = {}): AgentDefinition => {
  const c = checkDefinition({
    format: 1,
    name: "GitHub Code Verifier",
    job: { does: "Checks new commits in the owner's repositories for quality and tells them.", done: "Told." },
    triggers: [{ kind: "schedule", every: "day", at: "09:00", description: "Every day at 9" }],
    settings: [{ key: "repos", label: "Repositories", type: "list", help: "owner/name", choices: [], given: "vercel/next.js" }],
    rules: [{ key: "quality_threshold", label: "Lowest quality that passes", type: "number", value: "70", help: "1 to 100" }],
    memory: [],
    steps: [
      { id: "fetch_commits", kind: "code", title: "Fetch commits", description: "Read the newest commits of each repository.", inputs: [], outputs: ["commits"], tools: ["github.read"], next: "judge" },
      { id: "judge", kind: "code", title: "Judge quality", description: "Ask SERV to score each commit.", inputs: ["commits", "rules"], outputs: ["message"], tools: ["serv.reason"], next: null },
    ],
    actions: [],
    limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.1 },
    ...o,
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
};

// The live verifier's own step, as Dolphin wrote it.
const OCTOCAT = `async function run(input, tools) {
  const repos = [{ owner: "octocat", repo: "Hello-World" }];
  const commits = [];
  for (const { owner, repo } of repos) {
    const r = await tools.web.fetch({ url: \`https://api.github.com/repos/\${owner}/\${repo}/commits?per_page=10\` });
    commits.push(...JSON.parse(r.text));
  }
  return { commits };
}`;

describe("a target written into the code", () => {
  const d = plan();
  const fetch = { tools: ["web.fetch"] as CodeStepDef["tools"] };
  const github = { tools: ["github.read"] as CodeStepDef["tools"] };

  it("is found: an address it fetches, a repository, a recipient, a wallet, a number it compares against", () => {
    expect(writtenTarget(OCTOCAT, fetch, d)).toEqual({ what: 'the address "https://api.github.com/repos/${owner}/${repo}/commits?per_page=10"', from: "settings.repos (Repositories)" });
    expect(writtenTarget('async function run(input, tools) { return tools.github.read({ op: "commits", repo: "octocat/Hello-World" }); }', github, d)).toEqual({ what: 'the repository "octocat/Hello-World"', from: "settings.repos (Repositories)" });
    expect(writtenTarget('async function run(input, tools) { const repos = [{ owner: "octocat", repo: input.x }]; return {}; }', github, d)!.what).toBe('owner "octocat"');
    expect(writtenTarget('async function run(input) { return { to: "ops@example.com" }; }', { tools: [] }, d)!.what).toBe('the email address "ops@example.com"');
    expect(writtenTarget('async function run(input) { return { pay: "0x1111111111111111111111111111111111111111" }; }', { tools: [] }, d)!.what).toMatch(/^the wallet/);
    expect(writtenTarget("async function run(input, tools) { const passed = result.quality_score >= 70; return { passed }; }", { tools: [] }, d)).toEqual({ what: "the number 70 it compares result.quality_score against", from: "rules.quality_threshold (Lowest quality that passes)" });
    expect(writtenTarget('async function run(input, tools) { return tools.coingecko.read({ coins: ["ethereum"] }); }', { tools: ["coingecko.read"] }, d)!.what).toBe('coins "ethereum"');
  });

  it("isn't found in code that reads what the owner answered", () => {
    const clean = `async function run(input, tools) {
      // See https://docs.github.com/rest for the shape.
      const items = [];
      for (const repo of input.settings.repos) items.push(...(await tools.github.read({ op: "commits", repo })).items);
      const passed = items.filter((c) => c.score >= input.rules.quality_threshold && c.message.length > 3000 && c.issues > 0);
      return { commits: items, type: "text/plain", note: "N/A", url: \`https://github.com/\${input.settings.repos[0]}\` };
    }`;
    expect(writtenTarget(clean, github, d)).toBeNull();
    expect(writtenTarget('async function run(input) { return { status: "open", label: "and/or" }; }', { tools: [] }, d)).toBeNull();
  });

  it("fails the code's check in plain words, naming where it should come from", () => {
    const step = { ...(d.steps[0] as CodeStepDef), tools: ["web.fetch"] } as CodeStepDef;
    expect(checkCode(OCTOCAT, step, d)).toBe('It writes the address "https://api.github.com/repos/${owner}/${repo}/commits?per_page=10" into the code, so every owner would get the same one whatever they answered: read it from settings.repos (Repositories), which this step now reads.');
    // Without the plan, the check is as it was.
    expect(checkCode(OCTOCAT, step)).toBeNull();
  });
});

describe("what a step's code reads", () => {
  const d = plan();
  const judge = d.steps[1] as CodeStepDef;

  it("is declared from upstream when a step before it makes it, never written again for it", () => {
    const source = "async function run(input, tools) { const { commits } = input; const s = input.settings.repos; const r = await tools.serv.reason({ task: \"Score them\", data: commits }); return { message: String(commits.length + s.length) + r.text }; }";
    expect(fitInputs(judge, source, d)).toEqual({ inputs: ["commits", "rules", "settings"], invented: [] });
    expect(checkCode(source, { ...judge, inputs: ["commits", "rules", "settings"] }, d)).toBeNull();
  });

  it("is an invention when nothing makes it, and fails the check", () => {
    const source = "async function run(input, tools) { if (input.skip) return { message: null }; const r = await tools.serv.reason({ task: \"Score them\", data: input.commits }); return { message: r.text }; }";
    expect(fitInputs(judge, source, d).invented).toEqual(["skip"]);
    expect(checkCode(source, judge, d)).toBe("It reads input.skip, which this step isn't given (it gets commits, rules): read only those.");
  });
});

describe("writing a step that wrote a target in", () => {
  it("gives it the settings, sends it back with where to read it, and keeps what it then reads", async () => {
    const d = plan();
    const step = d.steps[0] as CodeStepDef;
    const fixed = "async function run(input, tools) { const commits = []; for (const repo of input.settings.repos) commits.push(...(await tools.github.read({ op: \"commits\", repo })).items); return { commits }; }";
    const answers = [`\`\`\`js\n${'async function run(input, tools) { return { commits: (await tools.github.read({ op: "commits", repo: "octocat/Hello-World" })).items }; }'}\n\`\`\``, `\`\`\`js\n${fixed}\n\`\`\``];
    const sent: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[]; response_format?: unknown };
      if (url.includes("dphn.ai")) {
        sent.push(body.messages.at(-1)!.content);
        return Response.json({ choices: [{ message: { content: answers.shift() } }] });
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "" }) } }] });
    }) as typeof fetch;
    const dolphin = modelConfig({ DOLPHIN_API_KEY: "test-dolphin" }).providers[0] as Provider;
    const serv = servOnly(modelConfig({ SERV_API_KEY: "test-serv", DOLPHIN_API_KEY: "test-dolphin" }));
    const entry = await writeStep(step, d, codeSpec(step), { dolphin, serv, fetchImpl, hooks: { progress: async () => {}, record: async () => {} } });
    expect(entry).toMatchObject({ status: "approved", source: fixed, rounds: 2, inputs: ["settings"] });
    expect(sent[1]).toContain('It was rejected: It writes the repository "octocat/Hello-World" into the code, so every owner would get the same one whatever they answered: read it from settings.repos (Repositories), which this step now reads.');
    expect(sent[1]).toContain("- settings: the renter's setup: { repos: list (Repositories; owner/name) }");
  });
});
