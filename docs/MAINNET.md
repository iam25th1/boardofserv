# Mainnet: a checklist for later

boardofserv runs on Base Sepolia with test USDC. Nothing in this build turns
real money on: agent payments refuse any mainnet chain id, RPC or USDC
address unless `AGENT_PAYMENTS_MAINNET=1`, and that is never set. This is
the list to work through, in order, if and when the owner decides to move
to Base mainnet. Every item is a decision or a check, not a switch to flip.

## 1. Decide it's time

- [ ] The beta has run for a while with real people on test money: jobs,
      payments, disputes, refunds and reconciliation have all happened
      for real, with no open payment alerts and no unexplained mismatches.
- [ ] The hosting questions in [HOSTING.md](HOSTING.md) are answered. Real
      money on a single home machine is a bigger risk than test money.
- [ ] Get advice on what taking and paying out real money needs where you
      live and where your users are. This checklist doesn't cover that.

## 2. A fresh start for the books

The ledger, balances, allowances and agent payments don't record which
chain they came from: every test USDC balance would become real USDC owed.
Start mainnet on a **fresh database** (or wipe every money table) and keep
the Sepolia one as an archive.

- [ ] New Postgres database for mainnet; Sepolia data exported and kept
      apart.
- [ ] `balances`, `ledger_entries`, `holds`, `allowances`,
      `allowance_entries`, `agent_payments`, `payment_alerts`, `deposits`,
      `withdrawals`, `disputes` and `rentals` start empty.
- [ ] Every listing's price checked: test prices become real prices.
- [ ] The public pages and the app changed from "beta, test money" to what
      is then true (the landing page's beta line, About, Using the beta, the
      test USDC notes in the wallet, spending and approvals). Every claim on
      a public page has to be true of the live product.

## 3. Fresh treasury and keys

- [ ] A **new** treasury wallet made for mainnet only, never used on a
      testnet. Its private key generated on a clean machine and put straight
      into Pier's store; never printed, never in a file, never reused.
- [ ] Keep only a working float in the hot treasury (what is owed plus a
      day of payments) and the rest in a separate cold wallet the server
      can't reach.
- [ ] A new `ADMIN_USER_IDS` review: only the people who should pause
      payments and approve withdrawals.
- [ ] Rotate `OPENSERV_KEY_ENC_KEY`, `PRIVY_APP_SECRET` and the database
      password for the new database; check nothing from the testnet setup
      is reused.

## 4. Chain, contract and settings

- [ ] Chain: Base mainnet, chain id **8453**.
- [ ] A dedicated RPC provider in `BOS_RPC_URL` (not the public endpoint),
      checked to answer chain id 8453.
- [ ] The USDC contract address **verified at the time from official
      sources**: Circle's list of USDC contract addresses
      (https://developers.circle.com/stablecoins/usdc-contract-addresses)
      and Base's documentation. Compare it, character by character, with
      the default in `src/lib/payments/config.ts` (`USDC_ADDRESS.base`) and
      set `USDC_TOKEN_ADDRESS` only if they differ. Don't take an address
      from this file, a chat or a search result.
- [ ] `BOS_NETWORK=base` and `BOS_MAINNET=1` (deposits and withdrawals).
- [ ] `AGENT_PAYMENTS_MAINNET=1` only after everything below is ready, and
      only by the owner.
- [ ] `DEPOSIT_CONFIRMATIONS` raised (10 or more) and `DEPOSIT_START_BLOCK`
      set to the block at the switch.
- [ ] `AGENT_RECONCILE_START_BLOCK` set to the same block, so
      reconciliation starts there.

## 5. Limits, low to begin with

Start small and raise them as things prove out.

- [ ] `WITHDRAW_AUTO_MAX_USDC` low (or 0: every withdrawal approved by an
      admin) and `WITHDRAW_DAILY_CAP_USDC` set.
- [ ] `AGENT_ALLOWANCE_MAX_USDC` low (for example 20).
- [ ] `AGENT_PAYMENTS_SITE_DAILY_USDC` low (for example 50).
- [ ] `AGENT_PAYMENTS_MIN_TREASURY_USDC` set to a float you keep topped up.
- [ ] Trust bands in `src/lib/trust/config.ts` reviewed: what an agent may
      pay without asking in real money.
- [ ] `PLATFORM_MODEL_BUDGET_USDC` and `DAILY_SPEND_LIMIT_USD` reviewed.

## 6. Funding

- [ ] ETH on Base in the treasury for gas (agent payments and payouts).
- [ ] USDC in the treasury for the float. The admin page's "Treasury and
      what it owes" must never show a negative difference.
- [ ] A written note of who tops the treasury up, from where, and when.

## 7. Test plan, with real but tiny amounts

Each step with a cent or two, the owner's own accounts on both sides.

1. [ ] `/api/health` reports Base and payments on; the admin page reads the
       treasury's real balances.
2. [ ] Deposit 1 USDC from a linked wallet; it is credited once, after the
       confirmations.
3. [ ] A deposit from an unlinked wallet shows as unmatched, not credited.
4. [ ] Withdraw 1 USDC; it waits for approval (or goes automatically within
       the auto limit), is sent once, and confirms.
5. [ ] Top up an allowance with 1 USDC, save a payee (the owner's second
       wallet), and let an agent pay 0.10 USDC: the first payment asks, the
       transfer confirms, the receipt links to basescan.org, and
       reconciliation matches it.
6. [ ] Pause agent payments from the admin page; a payment is refused with
       the reason. Turn them back on.
7. [ ] Drop the treasury below `AGENT_PAYMENTS_MIN_TREASURY_USDC` on a
       test: payments pause by themselves with an alert.
8. [ ] A rent dispute upheld refunds through the ledger (run
       `scripts/sql/ledger-kinds.sql` on the new database first).
9. [ ] A backup and a restore of the new database (see DEPLOY-PIER.md).
10. [ ] Watch the first days closely: payment alerts, the admin page's
        difference, reconciliation's checkpoint moving.

## 8. If something goes wrong

- Pause agent payments and payouts from the admin page first.
- Move the treasury's float to the cold wallet if the key may be exposed,
  then make a new treasury.
- Reconciliation alerts say what didn't match; nothing restarts payments
  until an admin has looked into every open alert.
