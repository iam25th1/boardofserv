import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ConversationDTO, PublicHelperDTO, SketchDTO } from "@/lib/types";
import { ToastProvider } from "@/components/ui";
import { ChatShell } from "./ChatShell";

// Publishing from the chat with the real dock and sheet; the network is
// replaced and records what was sent.

const blurb: SketchDTO = {
  name: "Shop blurb writer",
  kind: "answer",
  watches: null,
  when: null,
  how: null,
  tells: null,
  takes: "a product name and a few facts",
  does: "writes a friendly two line blurb",
  gives: "the blurb, ready to paste",
  asking: null,
  live: false,
};
const helper: PublicHelperDTO = {
  slug: "shop-blurb-writer",
  name: "Shop blurb writer",
  description: "Warm blurbs",
  inputHint: "A product and a few facts",
  maker: "maya",
  createdAt: "2026-10-22T09:00:00.000Z",
};

const api = vi.hoisted(() => ({
  conversations: [] as ConversationDTO[],
  published: null as PublicHelperDTO | null,
  publish: vi.fn(),
  unpublish: vi.fn(),
}));

vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ logout: () => {} }) }));
vi.mock("@/lib/useOpenServLink", () => ({ useOpenServLink: () => async () => {} }));
vi.mock("@/lib/useApi", () => {
  const client = {
    listConversations: async () => api.conversations,
    getAccount: async () => null,
    getConversation: async () => ({ messages: [{ id: "m1", conversationId: "c1", role: "user", content: "Write blurbs", source: null, sourceLabel: null, createdAt: "" }], sketch: blurb, published: api.published }),
    publishHelper: api.publish,
    unpublishHelper: api.unpublish,
    sendChat: () => () => {},
  };
  return { useApi: () => client };
});

const convo = (publishedSlug: string | null): ConversationDTO => ({
  id: "c1",
  title: "Write blurbs",
  sketchName: "Shop blurb writer",
  publishedSlug,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

async function openBlurb() {
  render(
    <ToastProvider>
      <ChatShell />
    </ToastProvider>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /agent/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Shop blurb writer/ }));
  });
}

beforeEach(() => {
  api.conversations = [convo(null)];
  api.published = null;
  api.publish.mockReset();
  api.unpublish.mockReset();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("publishing from the chat", () => {
  it("turns the switch into Publish, confirms on a sheet, and saves the sheet's edits", async () => {
    await openBlurb();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Ready to publish")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const sheet = screen.getByRole("dialog", { name: "Put it on the board" });
    expect(within(sheet).getByText("Shop blurb writer")).toBeInTheDocument();
    expect(within(sheet).getByLabelText("One line about it")).toHaveValue("Writes a friendly two line blurb");
    expect(within(sheet).getByLabelText("What to type")).toHaveValue("A product name and a few facts");
    expect(within(sheet).getByText(/Your instructions stay private/)).toBeInTheDocument();

    fireEvent.change(within(sheet).getByLabelText("One line about it"), { target: { value: "Warm blurbs" } });
    fireEvent.change(within(sheet).getByLabelText("What to type"), { target: { value: "A product and a few facts" } });
    api.publish.mockResolvedValue(helper);
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Publish" }));
    });
    expect(api.publish).toHaveBeenCalledWith({ conversationId: "c1", description: "Warm blurbs", inputHint: "A product and a few facts" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("On the board")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute("href", "/h/shop-blurb-writer");
  });

  it("keeps the sheet open with the reason when publishing fails", async () => {
    await openBlurb();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    api.publish.mockRejectedValue(new Error("Its instructions could not be written just now. Try again in a minute."));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Publish" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Its instructions could not be written just now.");
    expect(screen.getByRole("dialog", { name: "Put it on the board" })).toBeInTheDocument();
  });

  it("takes a published helper off the board from the agents popover", async () => {
    api.conversations = [convo("shop-blurb-writer")];
    api.published = helper;
    await openBlurb();
    expect(screen.getByRole("link", { name: "View" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /agent/ }));
    // Its row in the popover has the filled ring of a live helper.
    expect(document.querySelector('[aria-current="true"][data-state="live"]')).toHaveTextContent("Shop blurb writerOn the board");
    fireEvent.click(screen.getByRole("button", { name: "Take Shop blurb writer off the board" }));
    api.unpublish.mockResolvedValue({ ok: true });
    api.conversations = [convo(null)];
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Take it off the board?" })).getByRole("button", { name: "Take it down" }));
    });
    expect(api.unpublish).toHaveBeenCalledWith("shop-blurb-writer");
    expect(screen.queryByRole("link", { name: "View" })).toBeNull();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });
});
