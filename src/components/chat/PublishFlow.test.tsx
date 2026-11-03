import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AccountDTO, ConversationDTO, PublicHelperDTO, SketchDTO } from "@/lib/types";
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
  prices: [],
};

const api = vi.hoisted(() => ({
  conversations: [] as ConversationDTO[],
  published: null as PublicHelperDTO | null,
  account: null as AccountDTO | null,
  publish: vi.fn(),
  unpublish: vi.fn(),
  setHandle: vi.fn(),
  setPrices: vi.fn(),
  calls: [] as string[],
  payments: { enabled: false, currencies: [] } as unknown,
}));

vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ logout: () => {} }) }));
vi.mock("@/lib/useOpenServLink", () => ({ useOpenServLink: () => async () => {} }));
vi.mock("@/lib/publicApi", () => ({ fetchPayments: async () => api.payments, fetchHelper: async () => ({ helper: api.published }) }));
vi.mock("@/lib/useApi", () => {
  const client = {
    listConversations: async () => api.conversations,
    getAccount: async () => api.account,
    checkHandle: async (handle: string) => (handle === "maya" ? { available: false, error: "That handle is taken." } : { available: true }),
    setHandle: async (handle: string) => {
      api.calls.push(`handle ${handle}`);
      return api.setHandle(handle);
    },
    getConversation: async () => ({ messages: [{ id: "m1", conversationId: "c1", role: "user", content: "Write blurbs", source: null, sourceLabel: null, createdAt: "" }], sketch: blurb, published: api.published }),
    publishHelper: async (body: unknown) => {
      api.calls.push("publish");
      return api.publish(body);
    },
    unpublishHelper: api.unpublish,
    setPrices: api.setPrices,
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
  api.account = null;
  api.calls = [];
  api.publish.mockReset();
  api.unpublish.mockReset();
  api.setHandle.mockReset();
  api.setPrices.mockReset();
  api.payments = { enabled: false, currencies: [] };
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

  it("asks the maker to keep or change a random handle, and saves it before publishing", async () => {
    api.account = { email: "maya@example.com", handle: "maker_4821", handleChosen: false, walletAddress: null, openservUserId: null, linked: false, balance: "unknown" };
    await openBlurb();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const sheet = screen.getByRole("dialog", { name: "Put it on the board" });
    const field = within(sheet).getByLabelText("Your handle");
    expect(field).toHaveValue("maker_4821");
    expect(within(sheet).getByText(/We picked this one at random/)).toBeInTheDocument();
    expect(within(sheet).getByText("by @maker_4821")).toBeInTheDocument();
    const publish = within(sheet).getByRole("button", { name: "Publish" });

    fireEvent.change(field, { target: { value: "maya" } });
    await waitFor(() => expect(within(sheet).getByText("That handle is taken.")).toBeInTheDocument());
    expect(publish).toBeDisabled();
    fireEvent.change(field, { target: { value: "Maya_R" } });
    expect(within(sheet).getByText("by @maya_r")).toBeInTheDocument();
    await waitFor(() => expect(within(sheet).getByText("Available")).toBeInTheDocument());

    api.setHandle.mockResolvedValue({ handle: "maya_r", handleChosen: true });
    api.publish.mockResolvedValue({ ...helper, maker: "maya_r" });
    await act(async () => {
      fireEvent.click(publish);
    });
    expect(api.calls).toEqual(["handle maya_r", "publish"]);
    expect(api.publish).toHaveBeenCalledWith({ conversationId: "c1", description: "Writes a friendly two line blurb", inputHint: "A product name and a few facts" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("doesn't publish when the handle can't be saved", async () => {
    api.account = { email: "maya@example.com", handle: "maker_4821", handleChosen: false, walletAddress: null, openservUserId: null, linked: false, balance: "unknown" };
    await openBlurb();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    api.setHandle.mockRejectedValue(new Error("That handle is taken."));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Publish" }));
    });
    expect(api.calls).toEqual(["handle maker_4821"]);
    expect(screen.getByRole("alert")).toHaveTextContent("That handle is taken.");
  });

  it("doesn't ask again once the handle is chosen", async () => {
    api.account = { email: "maya@example.com", handle: "maya_r", handleChosen: true, walletAddress: null, openservUserId: null, linked: false, balance: "unknown" };
    await openBlurb();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const sheet = screen.getByRole("dialog", { name: "Put it on the board" });
    expect(within(sheet).queryByLabelText("Your handle")).toBeNull();
    expect(within(sheet).getByText("by @maya_r")).toBeInTheDocument();
    api.publish.mockResolvedValue(helper);
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Publish" }));
    });
    expect(api.calls).toEqual(["publish"]);
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

describe("prices", () => {
  const usdc = { code: "USDC", decimals: 6, token: `0x${"c".repeat(40)}`, withdrawMin: "5000000" };

  it("sets a price per use on the publish sheet, in minor units", async () => {
    api.payments = { enabled: true, currencies: [usdc] };
    await openBlurb();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const sheet = screen.getByRole("dialog", { name: "Put it on the board" });
    const price = within(sheet).getByLabelText("Price per use in USDC");
    fireEvent.change(price, { target: { value: "0.1234567" } });
    expect(within(sheet).getByRole("alert")).toHaveTextContent("at most 6 decimals");
    expect(within(sheet).getByRole("button", { name: "Publish" })).toBeDisabled();
    fireEvent.change(price, { target: { value: "0.25" } });
    api.publish.mockResolvedValue({ ...helper, prices: [{ currency: "USDC", amount: "250000", decimals: 6 }] });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Publish" }));
    });
    expect(api.publish).toHaveBeenCalledWith(expect.objectContaining({ prices: { USDC: "250000" } }));
  });

  it("shows no price field while payments are off", async () => {
    await openBlurb();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.queryByLabelText("Price per use in USDC")).toBeNull();
  });

  it("changes the price of a helper on the board from the agents popover", async () => {
    api.payments = { enabled: true, currencies: [usdc] };
    api.conversations = [convo("shop-blurb-writer")];
    api.published = { ...helper, prices: [{ currency: "USDC", amount: "250000", decimals: 6 }] };
    render(
      <ToastProvider>
        <ChatShell />
      </ToastProvider>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /agent/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set the price of Shop blurb writer" }));
    });
    const dialog = screen.getByRole("dialog", { name: "Price per use" });
    const price = within(dialog).getByLabelText("Price per use in USDC");
    expect(price).toHaveValue("0.25");
    fireEvent.change(price, { target: { value: "" } });
    api.setPrices.mockResolvedValue({ ...helper, prices: [] });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(api.setPrices).toHaveBeenCalledWith("shop-blurb-writer", { USDC: null });
    expect(screen.getByText("Free to try again")).toBeInTheDocument();
  });
});
