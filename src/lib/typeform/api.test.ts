// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fakeNet } from "@/test/fakeNet";
import { FAKE_FORM_ID, FAKE_TYPEFORM_TOKEN, fakeTypeform } from "@/test/fakeTypeform";
import { formIdOf, formResponses, tokenAccount, TypeformError, typeformLinkIn } from "./api";

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
  it("gives each response's answers under its question's title, unanswered ones as null, leaving out the ones taken", async () => {
    const net = fakeNet();
    fakeTypeform(net);
    const got = await formResponses(net.fetch, FAKE_TYPEFORM_TOKEN, FAKE_FORM_ID, { skip: new Set(["resp1"]) });
    expect(got.questions.map((q) => q.title)).toEqual(["Project name", "Team name", "Track", "Description", "Demo link", "Repo link"]);
    expect(got.responses.map((r) => r.id)).toEqual(["resp2", "resp3", "resp4", "resp5", "resp6"]);
    expect(got.responses.at(-1)).toMatchObject({ id: "resp6", answers: { "Project name": "Moonshot", "Team name": null, Track: null, Description: null, "Demo link": null, "Repo link": null } });
    expect(got.responses[0]!.answers.Track).toBe("Reppo");
    // The token only ever goes in the header.
    expect(net.calls.every((c) => !c.url.href.includes(FAKE_TYPEFORM_TOKEN))).toBe(true);
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
