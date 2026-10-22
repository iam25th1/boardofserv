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
2. Linking is optional: chatting never needs it. When the user links OpenServ
   from the account menu, that wallet signs OpenServ's SIWE message in the
   browser.
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
- Every request carries a system message, and json schemas lose their numeric
  range keywords: the rules SERV enforces. The chat switches no paid add-on on
  (no Prompt Guard, Shadow Agent or Kronos). A published helper's use declares
  `serv_prompt_guard` per request, to SERV only; nothing turns SERV's content
  filter off.
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

A sketch is one of four kinds. Watchers, digests and helpers are agents,
described by what they watch, when they act, how often they check and where
they tell you; their dock reads watch / decide / tell you. An answer helper is
asked something once and answers once: it is described by what it takes, what
it does and what it gives back, and its dock reads takes / does / gives. Once
those are set, the reply asks for the rules and the voice it should keep,
which stay in the conversation.

The agent sketch dock fills in from the conversation. Each turn makes two
calls, plan first and reply second. The plan is one non-streaming call with a
strict json_schema. It sees only the stored sketch, the reply the person is
answering and their new message, and returns the updated sketch, the field the
reply should ask about next and up to 4 answers to show as buttons. That result
is validated, trimmed (short fields), merged into the conversation's stored
sketch (a new value replaces a stored one, an empty one never wipes it) and
saved. Then the reply streams. Its system message carries one plain line of
what the sketch holds and what is missing, and exactly what to ask: "Ask about:
how (how often it checks). The user will see these buttons: ... Your question
must fit them." With nothing left to ask, the reply confirms the agent is fully
described. If the plan fails or does not validate, the reply still runs on the
stored sketch, picks its own question and shows no buttons. A reply that still
writes sketch JSON or the old `<<<SKETCH` block has it kept off the screen. The
stream sends the plan's `sketch` event first, so the dock fills in while the
thinking scribble still shows. Until then the dock says "sketching..." (a new
conversation has no dock yet: it appears with the first sketch). The reply's
words follow, then `reply_end`, which unlocks the composer and carries the
buttons, and then `done`. Agents cannot run yet, so a ready sketch says "Ready.
Switching on comes in the next update." and its switch stays disabled; there is
no cost line either.

In development only, `/?sketch=demo` (or `/demo?sketch=demo`) shows the dock
with the mockup's ETH watcher waiting on one answer, and `sketch=ready` shows
it ready so the switch can be flipped (local state only). `/demo?sketch=live`
and `sketch=live-ready` show the same agent the way a real conversation does,
and `sketching=1` adds the "sketching..." note it shows while the plan runs.
`/demo?sketch=answer` and `sketch=answer-ready` show an answer helper.
Production never loads the fixtures.

## Publishing helpers

When an answer helper's fields are all set, the dock's switch becomes a
Publish button (other kinds keep "Switching on comes in the next update").
Publish opens a confirm sheet: the public name, a one-line description and a
"what to type" hint the maker can edit, and a note that their instructions
stay private. Confirming runs one compile call (strict json_schema, `COMPILE_MAX_TOKENS`,
default 600): from the sketch and the conversation's recent messages, the
model writes the helper's private system prompt (rules, voice, format, what to
refuse). A line with a per-helper random canary is appended, which the helper
is told never to write.

`published_helpers` holds id, slug (unique, from the name), owner, name,
description, input hint, system prompt and canary (both server only), source
conversation, created and unpublished times. A conversation has at most one
helper on the board. The maker takes it down from the agents popover;
deleting the conversation takes it down too. The row stays, so the slug is
never reused and the helper's page says it was taken down.

The system prompt and the canary never leave the server: every query behind a
response selects the public columns only (`src/lib/helpers.ts`), and nothing
logs them. The maker's handle is the part of their email before the @.

The board, at `/board`, shows the helpers on it as short chalk cards (name,
description, maker handle), newest first, with a search by name. Signed out
visitors can browse it; the top bar links to it next to the agents pill. The
first time it loads, the cards are chalked on in a quick stagger; nothing
else on it moves by itself, and reduced motion turns that off too.

A helper's page, at `/h/:slug`, shows its name and description and an input
with its hint; the answer streams in with the same chalk-dust word effect as
the chat. Anyone can read the page; using the helper needs sign-in. Each use
is a fresh single turn: the helper's system prompt plus what was typed,
nothing else, on SERV only (a backup model would not know the guard). Every
use declares `serv_prompt_guard` and leaves the content filter on.

On the server, the answer streams through a leak guard
(`src/lib/leakGuard.ts`). If it carries the helper's canary, or 12 or more
consecutive words of its system prompt (compared ignoring case and
punctuation), the stream stops and the page shows "This helper can't share how
it works." To catch that before any of it shows, the guard holds back the
word still arriving and any tail of the answer that could be the start of
such a run, usually a word or two.

Until payments exist, uses run on the operator's key with a per-user limit:
`HELPER_DAILY_USES` (default 20) a day across all helpers, counted midnight to
midnight UTC. A failed use (no answer) does not count. The page shows the
uses left under the input and, at zero, when they reset. Each use writes one
`helper_uses` row: helper, user, tokens, latency and outcome (ok, blocked,
failed), never the input or the answer.

- `POST /api/helpers`: publish (signed in, owner of the conversation).
- `DELETE /api/helpers/:slug`: take it off the board (the maker only).
- `GET /api/board?q=`: the board, for anyone.
- `GET /api/helpers/:slug`: a helper's page, for anyone (410 once taken down).
- `POST /api/helpers/:slug/use`: one use, streamed (signed in).
- `GET /api/uses`: the signed-in user's uses left today.

`src/test/secrecy.test.ts` drives every API route, including a model that
echoes the prompt and the canary, and fails if any response body or console
line carries either.

