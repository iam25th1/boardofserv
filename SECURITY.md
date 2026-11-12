# Security

boardofserv is a beta. It runs on **Base Sepolia only**, with **test USDC**:
deposits, allowances, agent payments and withdrawals move testnet tokens
that have no value. Mainnet is switched off in code (`BOS_MAINNET` and
`AGENT_PAYMENTS_MAINNET` are never set), and turning it on is a separate,
reviewed change (see [docs/MAINNET.md](docs/MAINNET.md)).

Even so, a flaw here can still hurt people: accounts, linked Google Sheets
and Telegram chats, saved API keys, and model budgets that cost real money.
Please report anything you find.

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab,
then **Report a vulnerability**. Please don't open a public issue or pull
request for a security problem.

A useful report has:

- what an attacker can do, and to whom (another user, the operator, the
  treasury);
- the steps to reproduce it, against a local copy where you can
  (`npm run dev`, setup in the [README](README.md));
- the route, page or file involved, and the commit you looked at.

You'll get an answer within a week. Fixes go out as a normal pull request
once the problem is closed, and you're credited in it unless you'd rather
not be.

## Scope

In scope: this repository and the live beta at
https://boardofserv.25th.dev. For example: signing in as someone else,
reading or changing another user's agents, chats, connections or money,
getting around an approval, allowance, budget or limit, getting an
agent's code out of its sandbox, making the server fetch an internal
address, or a secret reaching the browser or a log.

Please don't:

- test against other people's accounts or data: make your own;
- run load tests or anything that degrades the beta for others;
- spend more than a few test tokens, or ask for testnet funds you won't use;
- use social engineering, or attack the hosting or Cloudflare.

Out of scope: the services boardofserv calls (OpenServ and SERV, Dolphin,
Reppo, Privy, Google, Telegram, Brave, Base); report those to their owners.
Reports that only show missing headers or best practices with no attack
are welcome, but they are lower priority.

## What keeps secrets out

- Every secret lives in the server's environment (`.env.local` locally;
  see [.env.example](.env.example)). Only `NEXT_PUBLIC_*` values reach the
  browser. A test (`src/test/secrecy.test.ts`) drives every API route and
  fails if the treasury key, a user's own key, a helper's hidden prompt or
  anyone's email turns up in a response body or a log line.
- Users' own SERV and OpenServ keys and their connection tokens (Telegram,
  Google) are encrypted at rest (AES-256-GCM) and decrypted only on the
  server, for the one call that needs them.
- CI runs with a read-only token and no secrets, and `gitleaks` reports no
  leaks in the tree (`gitleaks dir .`, config in `.gitleaks.toml`).
