import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PaymentsDTO, WalletDTO } from "@/lib/types";
import { WalletView } from "./WalletView";

// The wallet page with the network replaced.

const TREASURY = `0x${"7ea5".padStart(40, "0")}`;
const LINKED = `0x${"a11ce".padStart(40, "0")}`;

const payments: PaymentsDTO = {
  enabled: true,
  network: "base-sepolia",
  networkLabel: "Base Sepolia",
  chainId: 84532,
  mainnet: false,
  explorer: "https://sepolia.basescan.org",
  treasury: TREASURY,
  confirmations: 5,
  currencies: [{ code: "USDC", decimals: 6, token: `0x${"c".repeat(40)}`, withdrawMin: "5000000" }],
};

const net = vi.hoisted(() => ({
  wallet: null as unknown,
  checked: null as unknown,
  linkWallet: null as unknown as (o: unknown) => void,
  asked: [] as unknown[],
}));

vi.mock("@/lib/privy-config", () => ({ privyAppId: () => "app-id-for-the-page-test" }));
vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ready: true, authenticated: true }),
  useLinkAccount: () => ({ linkWallet: net.linkWallet }),
}));
vi.mock("@/lib/useApi", () => {
  const client = {
    getWallet: async () => net.wallet,
    checkDeposits: async () => net.checked,
    requestWithdrawal: async (body: unknown) => {
      net.asked.push(body);
      return net.wallet;
    },
  };
  return { useApi: () => client };
});

const base = (o: Partial<WalletDTO> = {}): WalletDTO => ({
  balances: [{ currency: "USDC", available: "0", held: "0" }],
  earned: [{ currency: "USDC", amount: "0" }],
  wallets: [{ address: LINKED, embedded: true }],
  deposits: [],
  withdrawals: [],
  ...o,
});

async function open(p: PaymentsDTO = payments) {
  render(<WalletView payments={p} qr={{ size: 21, d: "M0 0h1v1h-1z" }} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

beforeEach(() => {
  net.asked = [];
  net.linkWallet = vi.fn();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the wallet page", () => {
  it("says so when payments are off", async () => {
    await open({ ...payments, enabled: false, treasury: null, currencies: [] });
    expect(screen.getByText("Payments aren't set up here yet. Helpers stay free to try.")).toBeTruthy();
  });

  it("shows where to send, on which network in big letters, and the warning", async () => {
    net.wallet = base();
    await open();
    expect(screen.getByText("Base Sepolia", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("Send only USDC on Base Sepolia.")).toBeTruthy();
    expect(screen.getByText(/lost and can't be recovered/)).toBeTruthy();
    expect(screen.getByText(TREASURY)).toBeTruthy();
    expect(screen.getByRole("img", { name: "QR code of the deposit address" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy the deposit address" })).toBeTruthy();
    expect(screen.getByText(LINKED, { selector: "code" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Link a wallet" }));
    expect(net.linkWallet).toHaveBeenCalledWith(expect.objectContaining({ walletChainType: "ethereum-only" }));
  });

  it("says the balances are test USDC on Base Sepolia while it's a beta", async () => {
    net.wallet = base();
    await open();
    expect(screen.getAllByText("test USDC").length).toBeGreaterThan(0);
    expect(screen.getByText("Amounts here are test USDC on Base Sepolia, worth nothing while boardofserv is a beta.")).toBeTruthy();
  });

  it("checks for a deposit and says what was credited", async () => {
    net.wallet = base({ deposits: [{ id: "d1", currency: "USDC", amount: "1000000", txHash: `0x${"1".repeat(64)}`, status: "confirming", seenAt: "2026-11-02T10:00:00.000Z" }] });
    net.checked = base({
      balances: [{ currency: "USDC", available: "1000000", held: "0" }],
      deposits: [{ id: "d1", currency: "USDC", amount: "1000000", txHash: `0x${"1".repeat(64)}`, status: "credited", seenAt: "2026-11-02T10:00:00.000Z" }],
    });
    await open();
    expect(screen.getByText("confirming")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check for my deposit" }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.getByText("Credited 1.00 USDC.")).toBeTruthy();
    expect(screen.getByText("credited")).toBeTruthy();
  });

  it("opens withdrawals once the balance reaches the minimum, and sends minor units with a key", async () => {
    net.wallet = base({ balances: [{ currency: "USDC", available: "4000000", held: "0" }] });
    await open();
    expect(screen.getByText("You can withdraw once your balance reaches 5.00 USDC.")).toBeTruthy();
    cleanup();

    net.wallet = base({ balances: [{ currency: "USDC", available: "12000000", held: "0" }], earned: [{ currency: "USDC", amount: "9000000" }] });
    await open();
    expect(screen.getByText("9.00 USDC")).toBeTruthy();
    const amount = screen.getByPlaceholderText("0.00");
    fireEvent.change(amount, { target: { value: "4" } });
    expect(screen.getByText("The smallest withdrawal is 5.00 USDC.")).toBeTruthy();
    fireEvent.change(amount, { target: { value: "12.5" } });
    expect(screen.getByText("That is more than your balance.")).toBeTruthy();
    fireEvent.change(amount, { target: { value: "7.25" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(net.asked).toEqual([{ currency: "USDC", amount: "7250000", to: LINKED, key: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    expect(screen.getByText("Withdrawal asked for. Its status is below.")).toBeTruthy();
  });
});
