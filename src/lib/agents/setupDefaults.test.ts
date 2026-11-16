// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkerDefinition } from "@/test/githubChecker";
import { setupDefaults, type AgentDefinition } from "./definition";

// "Run it for real" starts from what the owner said in the chat and what
// they answered for the version running now, never from the sample the
// test made up (live, the setup offered acme-org/acme-web-app, a
// repository the owner never named).

const said = (given: string): AgentDefinition => {
  const d = checkerDefinition();
  return { ...d, settings: d.settings.map((s) => ({ ...s, given })) };
};

describe("where a setup starts", () => {
  it("is the owner's answer in the chat first", () => {
    expect(setupDefaults(said("iam25th1/boardofserv"), { definition: checkerDefinition(), settings: { github_repo: "someone/older-repo" } })).toEqual({ github_repo: "iam25th1/boardofserv" });
  });

  it("then what they answered for the version running now, the same question of the same kind", () => {
    const running = { definition: checkerDefinition(), settings: { github_repo: "iam25th1/boardofserv" } };
    expect(setupDefaults(checkerDefinition(), running)).toEqual({ github_repo: "iam25th1/boardofserv" });
    const asList = { ...checkerDefinition(), settings: checkerDefinition().settings.map((s) => ({ ...s, type: "list" as const })) };
    expect(setupDefaults(checkerDefinition(), { definition: asList, settings: { github_repo: ["iam25th1/boardofserv"] } })).toEqual({});
    expect(setupDefaults(checkerDefinition(), { definition: checkerDefinition(), settings: { github_repo: "" } })).toEqual({});
  });

  it("is empty with neither: never a sample's value", () => {
    expect(setupDefaults(checkerDefinition(), null)).toEqual({});
  });
});
