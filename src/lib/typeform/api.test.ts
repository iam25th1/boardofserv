// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fakeNet } from "@/test/fakeNet";
import { FAKE_FORM_ID, FAKE_TYPEFORM_TOKEN, fakeTypeform } from "@/test/fakeTypeform";
import { fieldKeys, formIdOf, formResponses, tokenAccount, TypeformError, typeformLinkIn } from "./api";

describe("a Typeform form's link", () => {
  it("gives the form's id, from any of its links", () => {
    expect(formIdOf("https://form.typeform.com/to/AbC123xy")).toBe("AbC123xy");
    expect(formIdOf("https://acme.typeform.com/to/AbC123xy?utm=x")).toBe("AbC123xy");
    expect(formIdOf("https://admin.typeform.com/form/AbC123xy/results")).toBe("AbC123xy");
    expect(formIdOf("AbC123xy")).toBe("AbC123xy");
    expect(formIdOf("https://example.com/to/AbC123xy")).toBeNull();
    expect(formIdOf("not a link at all")).toBeNull();
  });

  it("is found in what the maker said, without the full stop after it", () => {
    expect(typeformLinkIn("Score each submission to my Typeform https://form.typeform.com/to/AbC123xy.")).toBe("https://form.typeform.com/to/AbC123xy");
    expect(typeformLinkIn("Read https://example.com/page and https://typeform.com/pricing")).toBeNull();
  });
});

describe("reading a form with the owner's token", () => {
  it("gives each response as a record of its answers, each under its question's field name, unanswered ones as null, leaving out the ones taken", async () => {
    const net = fakeNet();
    fakeTypeform(net);
    const got = await formResponses(net.fetch, FAKE_TYPEFORM_TOKEN, FAKE_FORM_ID, { skip: new Set(["resp1"]) });
    expect(got.questions.map((q) => [q.key, q.title])).toEqual([
      ["project_name", "Project name"],
      ["team_name", "Team name"],
      ["track", "Track"],
      ["description", "Description"],
      ["demo_link", "Demo link"],
      ["repo_link", "Repo link"],
    ]);
    expect(got.responses.map((r) => r.id)).toEqual(["resp2", "resp3", "resp4", "resp5", "resp6"]);
    expect(got.responses.at(-1)).toEqual({ id: "resp6", submittedAt: "2026-11-13T09:05:00.000Z", project_name: "Moonshot", team_name: null, track: null, description: null, demo_link: null, repo_link: null });
    expect(got.responses[0]!.track).toBe("Reppo");
    // The token only ever goes in the header.
    expect(net.calls.every((c) => !c.url.href.includes(FAKE_TYPEFORM_TOKEN))).toBe(true);
  });

  it("names every question's field once, never as the response's own id", () => {
    expect(fieldKeys(["What's your project called?", "Team", "Team!", "ID", "Submitted at", "\u00bfQu\u00e9?", "1st pick"])).toEqual(["what_s_your_project_called", "team", "team_2", "id_2", "submitted_at_2", "qu", "q_1st_pick"]);
  });

  it("says plainly when the token doesn't work, never with the token in it", async () => {
    const net = fakeNet();
    fakeTypeform(net);
    const err = await tokenAccount(net.fetch, "tfp_wrong_token_xxxxx").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeformError);
    expect((err as TypeformError).status).toBe(401);
    expect(String((err as Error).message)).not.toContain("tfp_");
    expect(await tokenAccount(net.fetch, FAKE_TYPEFORM_TOKEN)).toBe("sample-maker");
  });
});
