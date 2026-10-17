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
- anime.js for motion, react-markdown for messages, Vitest for tests.

## Running it

```sh
cp .env.example .env.local      # then fill in the values below
npm ci --ignore-scripts
npm run db:up                   # local Postgres in Docker on port 5433
npm run db:push                 # create the tables
npm run dev                     # http://localhost:3000
```

`.env.local` (gitignored, never committed, never logged, never in the bundle):

- `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`: from the Privy dashboard. The
  app id is public by design; the secret is server only.
- `OPENSERV_KEY_ENC_KEY`: 32 bytes, base64. Generate with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- `DATABASE_URL`: defaults to the Docker Postgres above.
- `FALLBACK_BASE_URL`, `FALLBACK_API_KEY`, `FALLBACK_MODEL`, `FALLBACK_LABEL`:
  an OpenAI-compatible model used only when SERV is unavailable.

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

Replies are built to come from SERV Reasoning with no features switched on. The
model layer (`src/lib/serv.ts`) always sends a system message and strips numeric
range keywords from any json schema, the two things SERV rejects. On a 402, a
timeout or any error it falls back to the configured model, and every stored
message records which model actually answered: SERV replies are labelled SERV,
a fallback reply names the model that answered and never reads as SERV.

Note on the current phase: SERV Reasoning is served by OpenServ's runtime, which
authenticates with an agent-scoped key, not the user's platform key. Minting that
key is agent provisioning, which belongs to the next phase, so until then the
chat answers with the configured fallback model (labelled honestly). The model
layer already calls SERV and will use it as soon as that key is available.

## Design

The visual direction is "Workbench": warm paper, ink text, one deep teal accent,
one characterful serif used only for the wordmark and the welcome line. No
purple, no gradients, no side colour bars. Tokens live in
`src/design/tokens.css` and are the single source of every value.

For reviewing the UI without a live email login, a development-only harness at
`/demo` renders the real components with seeded data (it returns 404 in
production). States: `/demo?state=empty|convo|streaming|error`, with `menu=1`,
`drawer=1`, and `balance=low` flags.
