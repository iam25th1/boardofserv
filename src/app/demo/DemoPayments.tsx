"use client";
import { useRef } from "react";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { AdminBody, type AdminApi } from "@/app/app/admin/AdminView";
import { WalletBody, type QrPath, type WalletApi } from "@/app/app/wallet/WalletView";
import type { AdminDTO, PaymentsDTO, WalletDTO } from "@/lib/types";
import wallet from "@/app/app/wallet/wallet.module.css";
import admin from "@/app/app/admin/admin.module.css";

// Development only: the wallet and admin pages with canned data, so they can
// be reviewed and screenshotted without a sign-in or a chain.

const LINKED = "0x51a7e9b0c4d2f8a6e3b1c9d7f5a2e0c8b6d4f2a1";
const EMBEDDED = "0x5f8800c1d2e3f4a5b6c7d8e9f0a1b2c3d4e53148";
const hash = (n: number) => `0x${n.toString(16).padStart(4, "0").repeat(16)}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const paymentsFor = (treasury: string): PaymentsDTO => ({
  enabled: true,
  network: "base-sepolia",
  networkLabel: "Base Sepolia",
  chainId: 84532,
  mainnet: false,
  explorer: "https://sepolia.basescan.org",
  treasury,
  confirmations: 5,
  currencies: [
    { code: "USDC", decimals: 6, token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", withdrawMin: "5000000" },
    { code: "SERV", decimals: 18, token: "0x5e7Ad0C0fFee2B6f4E3c9A1d0B8e7F6a5C4d3B2a", withdrawMin: null },
  ],
});

const startWallet: WalletDTO = {
  balances: [
    { currency: "USDC", available: "12400000", held: "250000" },
    { currency: "SERV", available: "0", held: "0" },
  ],
  earned: [
    { currency: "USDC", amount: "9000000" },
    { currency: "SERV", amount: "0" },
  ],
  wallets: [
    { address: EMBEDDED, embedded: true },
    { address: LINKED, embedded: false },
  ],
  deposits: [
    { id: "d3", currency: "USDC", amount: "1000000", txHash: hash(3), status: "confirming", seenAt: ago(1) },
    { id: "d2", currency: "USDC", amount: "10000000", txHash: hash(2), status: "credited", seenAt: ago(90) },
    { id: "d1", currency: "USDC", amount: "2000000", txHash: hash(1), status: "dropped", seenAt: ago(600) },
  ],
  withdrawals: [
    { id: "w3", currency: "USDC", amount: "25000000", to: LINKED, status: "awaiting_approval", reason: "Over the automatic limit: an admin approves it.", txHash: null, createdAt: ago(5) },
    { id: "w2", currency: "USDC", amount: "6000000", to: LINKED, status: "paid", reason: null, txHash: hash(5), createdAt: ago(300) },
    { id: "w1", currency: "USDC", amount: "5000000", to: LINKED, status: "reverted", reason: null, txHash: hash(4), createdAt: ago(900) },
  ],
};

function walletApi(): WalletApi {
  let w = startWallet;
  return {
    getWallet: async () => w,
    checkDeposits: async () => {
      w = {
        ...w,
        balances: [{ currency: "USDC", available: "13400000", held: "250000" }, w.balances[1]!],
        deposits: w.deposits.map((d) => (d.id === "d3" ? { ...d, status: "credited" } : d)),
      };
      return w;
    },
    requestWithdrawal: async (body) => {
      w = {
        ...w,
        withdrawals: [{ id: `w${Date.now()}`, currency: body.currency, amount: body.amount, to: body.to, status: "queued", reason: null, txHash: null, createdAt: new Date().toISOString() }, ...w.withdrawals],
      };
      return w;
    },
  };
}

const adminFor = (treasury: string): AdminDTO => ({
  access: {
    inviteOnly: true,
    waiting: [{ id: "00000000-0000-4000-8000-000000000001", handle: "maker_2207", email: "jo@example.com", joinedAt: new Date(Date.UTC(2026, 10, 7, 14)).toISOString() }],
  },
  spend: { today: 0.4213, limit: 2, resetsAt: new Date(Date.UTC(2026, 10, 9)).toISOString() },
  codeFallbacks: { last30Days: 1, total: 3 },
  network: "base-sepolia",
  networkLabel: "Base Sepolia",
  chainId: 84532,
  explorer: "https://sepolia.basescan.org",
  treasury,
  paused: false,
  signer: null,
  currencies: [
    { code: "USDC", decimals: 6, treasury: "61250000", owed: "57650000", difference: "3600000", fees: "1600000", problem: null },
    { code: "SERV", decimals: 18, treasury: "0", owed: "0", difference: "0", fees: "0", problem: null },
  ],
  approvals: [
    { id: "a1", currency: "USDC", amount: "25000000", to: LINKED, status: "awaiting_approval", reason: "Over the automatic limit: an admin approves it.", txHash: null, createdAt: ago(5), maker: "maya_r", auto: false, nonce: null, stuck: false },
  ],
  history: [
    { id: "h3", currency: "USDC", amount: "8000000", to: LINKED, status: "broadcast", reason: null, txHash: hash(9), createdAt: ago(40), maker: "sam", auto: true, nonce: 7, stuck: true },
    { id: "h2", currency: "USDC", amount: "6000000", to: LINKED, status: "paid", reason: null, txHash: hash(5), createdAt: ago(300), maker: "maya_r", auto: true, nonce: 6, stuck: false },
    { id: "h1", currency: "USDC", amount: "5000000", to: LINKED, status: "reverted", reason: null, txHash: hash(4), createdAt: ago(900), maker: "maya_r", auto: false, nonce: 5, stuck: false },
  ],
  unmatched: [{ id: "u1", currency: "USDC", amount: "3000000", from: "0xbad0c0ffee2b6f4e3c9a1d0b8e7f6a5c4d3b2a19", txHash: hash(7), seenAt: ago(120) }],
});

function adminApi(treasury: string): AdminApi {
  let a = adminFor(treasury);
  return {
    getAdmin: async () => a,
    adminPause: async (paused) => (a = { ...a, paused }),
    adminDecide: async (id, action) => {
      const w = [...a.approvals, ...a.history].find((x) => x.id === id)!;
      const status = action === "approve" ? "queued" : action === "reject" ? "rejected" : "failed";
      a = { ...a, approvals: a.approvals.filter((x) => x.id !== id), history: [{ ...w, status, stuck: false }, ...a.history.filter((x) => x.id !== id)] };
      return a;
    },
    adminAccess: async (id) => (a = { ...a, access: { ...a.access, waiting: a.access.waiting.filter((u) => u.id !== id) } }),
  };
}

// The QR code is drawn on the server, so the page passes the address in.
export function DemoPayments({ view, qr, treasury }: { view: "wallet" | "admin"; qr: QrPath; treasury: string }) {
  const apis = useRef<{ wallet: WalletApi; admin: AdminApi } | null>(null);
  apis.current ??= { wallet: walletApi(), admin: adminApi(treasury) };
  const styles = view === "wallet" ? wallet : admin;
  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/app/chat">Your agents</TopLink>} />
      <main className={styles.col}>
        <header className={styles.head}>
          <h1>{view === "wallet" ? "Your wallet" : "Admin"}</h1>
          {view === "wallet" && <p className={wallet.note}>top up, pay for helpers, withdraw what you earn</p>}
        </header>
        {view === "wallet" ? (
          <WalletBody payments={paymentsFor(treasury)} qr={qr} api={apis.current.wallet} onLinkWallet={() => {}} />
        ) : (
          <AdminBody api={apis.current.admin} />
        )}
      </main>
    </div>
  );
}
