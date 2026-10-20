# boardofserv

A chat where you describe an agent in plain English and it gets built for you on
[OpenServ](https://openserv.ai). This is phase 1, the app shell: email login,
linking each user to their own OpenServ account, and the conversation. Building
agents is the next phase. The chat is the product, so it got the most care.

## Stack

- Next.js App Router, TypeScript.
- Privy for email login and a plain embedded Ethereum wallet (an EOA, never a
  smart wallet, which OpenServ sign-in would likely reject).
- Postgres with Drizzle, local Postgres in Docker for development.
- Plain CSS variables and CSS Modules. Every value is a design token.
- anime.js v4 for motion, react-markdown for messages, Vitest for tests.

## Running it

```sh
cp .env.example .env.local      # then fill in the values below
npm ci --ignore-scripts
npm run db:up                   # local Postgres in Docker on port 5433
npm run db:push                 # create the tables
npm run dev                     # http://localhost:3000
```

`npm run db:up` uses `docker compose` when the plugin is installed. Without it
(for example plain Colima) it runs the same Postgres with `docker run` in a
container named `boardofserv-db`, and starts that container again if it
already exists. `npm run db:down` stops whichever one is in use; the data stays
in the `boardofserv_boardofserv_pgdata` volume either way.

`.env.local` (gitignored, never committed, never logged, never in the bundle):

- `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`: from the Privy dashboard. The
  app id is public by design; the secret is server only. Without a usable app
  id (CI builds with `ci-placeholder`) the app still builds, Privy is never
  mounted, and the sign-in and chat pages say sign-in isn't set up.
- `OPENSERV_KEY_ENC_KEY`: 32 bytes, base64. Generate with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- `DATABASE_URL`: defaults to the Docker Postgres above.
- `SERV_API_KEY`: SERV Reasoning, which answers the chat. Server only.
- `FALLBACK_BASE_URL`, `FALLBACK_API_KEY`, `FALLBACK_MODEL`, `FALLBACK_LABEL`:
  an OpenAI-compatible backup, tried when SERV fails before its first token.
- `MODEL_FIRST_TOKEN_TIMEOUT_MS` (optional, default 20000): how long a model
  may stay silent before the reply moves on to the backup or is cut off.
- `CHAT_HISTORY_MESSAGES` (optional, default 12) and `CHAT_MAX_TOKENS`
  (optional, default 700): how much history goes to the model and how long a
  reply may be.

With neither SERV nor a backup set, a development build answers with a
labelled demo reply; a production build shows a plain error instead.

```sh
npm run gate     # typecheck, lint, test, build. Run before every commit.
```

## How a user signs in and links OpenServ

1. The user signs in with an email code through Privy and gets an embedded EOA.
2. On first use, that wallet signs OpenServ's SIWE message in the browser.
3. The server completes sign-in (`/auth/wallet/verify`), receives the user's
   OpenServ API key, encrypts it with `OPENSERV_KEY_ENC_KEY`, and stores only the
   ciphertext. The key is decrypted on the server when a request to OpenServ is
   made, and never sent to the browser.

## Security

This app holds access to every user's OpenServ account, so secrets never leave
the server:

- Each OpenServ key is encrypted at rest (AES-256-GCM, `src/lib/crypto.ts`) and
  decrypted only on the server.
- Server modules import `server-only`, so an accidental client import fails the
  build rather than shipping a secret to the browser.
- `src/test/secret-leak.test.ts` fails the build if a Client Component imports a
  server module or reads a server secret, if any tracked file contains a
  secret-shaped string, if an env file with secrets is tracked, or if a secret
  value appears in the built client bundle.

## The model behind the chat

`src/lib/model.ts` holds an ordered list of OpenAI-compatible providers: SERV
Reasoning (`https://inference-api.openserv.ai/v1`, model `claude-haiku-4.5`,
`SERV_API_KEY` as a bearer token) first, then the backup from `FALLBACK_*`.
Replies stream from whichever answers first.

- Before the first token, a network error, a timeout, a 5xx, a 429, a 402 or an
  empty reply moves on to the next provider. Each provider is tried once per
  reply, so a 402 (out of credit) is never retried. Any other refusal stops.
- After the first token nothing is retried. The reply ends with "Reply cut off.
  Try again."
- If nothing answers, the thread shows a plain error that says what happened
  and what to do. There is no fake reply.
- Every request carries a system message and no paid add-on (no Prompt Guard,
  Shadow Agent or Kronos), and json schemas lose their numeric range keywords:
  the rules SERV enforces.
- Every stored reply records which provider answered, and the UI labels it.

Usage stays low: one short system prompt (`src/lib/systemPrompt.ts`) plus the
last 12 messages (older history is dropped, not summarised), and replies capped
at 700 tokens. Each reply writes one `reply_usage` row: conversation, provider,
model, prompt and completion tokens when reported, time to first token, total
time and outcome (ok, fell back, failed). It never stores message text.

## Design

The visual direction is "Chalk": chalk on slate when dark, marker on a
whiteboard when light, Onest for reading and Caveat for small handwritten notes. No
purple, no gradients, no side colour bars. Tokens live in
`src/design/tokens.css` and are the single source of every value.

For reviewing the UI without a live email login, a development-only harness at
`/demo` renders the real components with seeded data (it returns 404 in
production). States: `/demo?state=empty|convo|thinking|streaming|replay|error`, with
`menu=1`, `agents=1`, `chips=1`, `backup=1` (the reply as if the backup model
answered it) and `balance=low` flags. `replay` plays the seeded reply through
the streaming path (`repeat=8` makes it long).

The agent sketch dock has no real data yet. In development only,
`/?sketch=demo` (or `/demo?sketch=demo`) shows it with the mockup's ETH
watcher waiting on one answer, and `sketch=ready` shows it ready so the switch
can be flipped. The switch only changes local state. Production never loads
the fixture.
