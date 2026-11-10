import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HelperEvent, PublicHelperDTO, WalletDTO } from "@/lib/types";
import HelperPageView from "./page";

// The page reads its slug from the address (next/navigation), as Next 16 has it.
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "shop-blurbs" }) }));

// A paid helper's page, with the network replaced.

const helper: PublicHelperDTO = {
  slug: "shop-blurbs",
  name: "Shop blurbs",
  description: "Friendly blurbs for your shop",
  inputHint: "A product and a few facts",
  maker: "maya",
  createdAt: "2026-10-22T09:00:00.000Z",
  prices: [
    { currency: "USDC", amount: "250000", decimals: 6 },
    { currency: "SERV", amount: "3000000000000000000", decimals: 18 },
  ],
};

const net = vi.hoisted(() => ({
  signedIn: true,
  wallet: null as unknown,
  emit: null as null | ((e: HelperEvent) => void),
  asked: [] as { input: string; pay?: { currency: string; price: string } }[],
}));

vi.mock("@/lib/privy-config", () => ({ privyAppId: () => "app-id-for-the-page-test" }));
vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ ready: true, authenticated: net.signedIn }) }));
vi.mock("@/lib/publicApi", () => ({ fetchHelper: async () => ({ helper }) }));
vi.mock("@/lib/useApi", () => {
  const client = {
    getQuota: async () => ({ limit: 20, remaining: 20, resetsAt: "2026-10-23T00:00:00.000Z" }),
    getWallet: async () => net.wallet,
    runHelper: (_slug: string, input: string, on: (e: HelperEvent) => void, pay?: { currency: string; price: string }) => {
      net.asked.push({ input, pay });
      net.emit = on;
      return () => {};
    },
  };
  return { useApi: () => client };
});
vi.mock("@/components/chat/Thinking", () => ({ Thinking: () => <p>thinking</p> }));

const walletWith = (usdc: string, serv: string): WalletDTO => ({
  balances: [
    { currency: "USDC", available: usdc, held: "0" },
    { currency: "SERV", available: serv, held: "0" },
  ],
  earned: [],
  wallets: [],
  deposits: [],
  withdrawals: [],
});

async function open() {
  render(<HelperPageView />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

afterEach(() => {
  cleanup();
  net.asked = [];
  net.signedIn = true;
});

describe("a paid helper's page", () => {
  it("tells a signed-out visitor what a use costs", async () => {
    net.signedIn = false;
    await open();
    expect(screen.getByText("0.25 USDC or 3.00 SERV a use, from your wallet.")).toBeTruthy();
  });

  it("shows the price and what is left under the input, and pays from the picked balance", async () => {
    net.wallet = walletWith("4750000", "0");
    await open();
    expect(screen.getByText("0.25 USDC a use, 4.75 USDC left")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "USDC" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.change(screen.getByLabelText("What to give Shop blurbs"), { target: { value: "The Alder mug" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(net.asked).toEqual([{ input: "The Alder mug", pay: { currency: "USDC", price: "250000" } }]);
    await act(async () => {
      net.emit!({ type: "delta", text: "A mug." });
      net.emit!({ type: "done", balance: { currency: "USDC", available: "4500000", held: "0" } });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByText("0.25 USDC a use, 4.50 USDC left")).toBeTruthy();
  });

  it("starts on a balance that covers the price, and says when none does", async () => {
    net.wallet = walletWith("100000", "5000000000000000000");
    await open();
    expect(screen.getByRole("radio", { name: "SERV" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("3.00 SERV a use, 5.00 SERV left")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "USDC" }));
    expect(screen.getByText(/0.25 USDC a use, 0.10 USDC left. Not enough for a use./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Top up" }).getAttribute("href")).toBe("/app/wallet");
    fireEvent.change(screen.getByLabelText("What to give Shop blurbs"), { target: { value: "Hi" } });
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a refusal for a short balance", async () => {
    net.wallet = walletWith("4750000", "0");
    await open();
    fireEvent.change(screen.getByLabelText("What to give Shop blurbs"), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await act(async () => {
      net.emit!({ type: "error", message: "Not enough USDC. Top up your wallet to use this helper.", balance: { currency: "USDC", available: "100", held: "0" } });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByRole("alert").textContent).toBe("Not enough USDC. Top up your wallet to use this helper.");
    expect(screen.getByText(/0.0001 USDC left. Not enough for a use./)).toBeTruthy();
  });

  it("shows the new price when it changed since the page loaded", async () => {
    net.wallet = walletWith("4750000", "0");
    await open();
    fireEvent.change(screen.getByLabelText("What to give Shop blurbs"), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await act(async () => {
      net.emit!({
        type: "error",
        message: "The price is now 0.90 USDC a use. Check it and ask again.",
        prices: [{ currency: "USDC", amount: "900000", decimals: 6 }],
      });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByRole("alert").textContent).toBe("The price is now 0.90 USDC a use. Check it and ask again.");
    expect(screen.getByText("0.90 USDC a use, 4.75 USDC left")).toBeTruthy();
  });
});
