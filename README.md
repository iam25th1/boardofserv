# boardofserv

Live at **https://boardofserv.25th.dev** (Base Sepolia), served from this Mac
by Pier: see [docs/DEPLOY-PIER.md](docs/DEPLOY-PIER.md).

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
npm run db:up                   # local Postgres in Docker on 127.0.0.1:5433
npm run db:push                 # create the tables
npm run dev                     # http://localhost:3000
```

A database created before handles existed that already has users in it can't
take the new not-null `handle` column from `db:push`. Run
`src/lib/db/migrations/0008_user_handles.sql` against it once first (for
example `docker exec -i boardofserv-db psql -U boardofserv boardofserv < src/lib/db/migrations/0008_user_handles.sql`),
which gives every user a random handle; `db:push` then has nothing left to do.

A deploy runs `npm run db:push:deploy` instead (`scripts/db-push.ts`). With
no terminal, `drizzle-kit push` applies an additive change but gives up on
one it would ask about (data loss, or a rename it can't tell apart) and still
exits 0; the wrapper fails the deploy then, so such a change is made by hand
first (see [docs/DEPLOY-PIER.md](docs/DEPLOY-PIER.md)).

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
- `DOLPHIN_API_KEY`, and optionally `DOLPHIN_BASE_URL` and `DOLPHIN_MODEL`
  (defaults: `https://lighthouse.dphn.ai/run/text-v/v1` and
  `deepseek-ai/DeepSeek-V4.1-Flash`, from Dolphin's docs): the chat's second
  model, tried when SERV fails before its first token. Server only.
- `FALLBACK_BASE_URL`, `FALLBACK_API_KEY`, `FALLBACK_MODEL`, `FALLBACK_LABEL`:
  an OpenAI-compatible backup, tried last, and only with all three of the
  first set.
- `INVITE_ONLY` (optional, on unless `0`, `false`, `no` or `off`): accounts
  wait for an admin's approval before they can chat (see "Invite-only").
- `CHAT_DAILY_LIMIT` (optional, default 30): messages each person may send a
  day. `DAILY_SPEND_LIMIT_USD` (optional, default 5): the most the site
  spends a day on the operator's model keys (see "Spend limits" below).
- `SERV_PRICE_INPUT_PER_M`, `SERV_PRICE_OUTPUT_PER_M` (defaults 1.25 and
  6.5), `DOLPHIN_PRICE_INPUT_PER_M`, `DOLPHIN_PRICE_OUTPUT_PER_M` (0.01 and
  0.07) and `FALLBACK_PRICE_INPUT_PER_M`, `FALLBACK_PRICE_OUTPUT_PER_M`
  (SERV's): what each model costs in US dollars per million tokens, for the
  daily spend estimate.
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

`npm run gate` builds into `.next`, which is also where a running `npm run dev`
keeps its files, so run it in a separate checkout (or with the development
server stopped).

A production build runs with `npm run build` then `npm run start:prod`, which
serves on 127.0.0.1:7560 (the deployment is in
[docs/DEPLOY-PIER.md](docs/DEPLOY-PIER.md)). In production, `/demo` and the
`?sketch=` fixtures are gone (`src/test/production.test.ts` starts the built
server and checks). `GET /api/health` answers
`{"ok":true,"database":"up","network":"Base Sepolia","payments":"on"}`, or a
503 with `ok: false` while the database can't be reached; it never carries an
address, a version or an error.

## How a user signs in, and their own SERV key

1. The user signs in with an email code through Privy and gets an embedded EOA.
   Privy loads from its own site, which Brave's shields or an ad blocker can
   stop. If it isn't ready within 10 seconds, the sign-in and chat pages say
   "Sign-in couldn't load. If you use Brave or an ad blocker, allow this site,
   then try again." with a Retry button that loads the page again.
2. Chatting needs nothing else: it runs on the site's own model keys, within
   the daily limits below.
3. "Use your own SERV key" in the account menu takes the user's own SERV
   inference key. The server checks it with one request of one output token,
   on that key's own credit (`src/lib/servKey.ts`): SERV must answer 200, so a
   refused key or one out of credit is turned away with a plain sentence. The
   key is then encrypted with `OPENSERV_KEY_ENC_KEY`, only the ciphertext and
   its last four characters are stored, and the menu shows it as "Ending abcd"
   with Remove. From then on the user's chat turns, plan calls, publishing and
   helper uses go to SERV on their key and nowhere else (no Dolphin, no
   backup), with no daily message limit, outside the site's spend limit and
   never paused by it.

### Invite-only

`INVITE_ONLY` (on unless set to `0`, `false`, `no` or `off`). Every account
starts out waiting, accounts from before this too. A signed-in account an
admin hasn't approved sees a waitlist screen in place of the chat, and the
routes that call a model (chat, publishing, using a helper, saving a SERV key)
answer 403. The board, the helper pages and the wallet stay open, signed in
or not. /admin lists the accounts waiting to get in, oldest first, by handle
and email, with Approve and Reject; it is the one place an email is shown to
anyone but its owner. Admins (`ADMIN_USER_IDS`) are always let in.

Linking an OpenServ account (the embedded wallet signing OpenServ's SIWE
message, the server storing the API key that sign-in returns, encrypted) is
no longer offered in the account menu. Its code (`src/lib/useOpenServLink.ts`,
`/api/openserv/link/*`) and stored keys are kept, and an account linked
before still shows as linked.

## Security

This app holds access to every user's OpenServ account, so secrets never leave
the server:

- Each OpenServ key and each user's own SERV key is encrypted at rest
  (AES-256-GCM, `src/lib/crypto.ts`) and decrypted only on the server. A SERV
  key is shown to its owner as its last four characters and is never in a
  response or a log line (`src/test/secrecy.test.ts`).
- Server modules import `server-only`, so an accidental client import fails the
  build rather than shipping a secret to the browser.
- `src/test/secret-leak.test.ts` fails the build if a Client Component imports a
  server module or reads a server secret, if any tracked file contains a
  secret-shaped string, if an env file with secrets is tracked, or if a secret
  value appears in the built client bundle.
- Every response carries security headers (`next.config.mjs`): a content
  security policy following Privy's guidance (Privy's iframe and API, Coinbase
  Wallet, Cloudflare Turnstile, `frame-ancestors 'none'`) plus Reown's for the
  WalletConnect modal Privy opens to link a wallet (its config, fonts and
  wallet logos come from Reown's hosts), `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: strict-origin-when-cross-origin`. The development server
  only sends `frame-ancestors 'none'` from the policy, since fast refresh needs
  eval. After a Privy upgrade, check sign-in and wallet linking against the
  policy again (the browser console names anything it blocks). The
  Cloudflare Web Analytics beacon the 25th.dev zone injects is allowed through
  the two hosts Cloudflare lists for it: `static.cloudflareinsights.com` for
  the script and `cloudflareinsights.com` for connections.

What is locked down, and what isn't yet:

- Next.js is on 14.2.35, the last 14.2 release, with every fix that reached
  14.2. `npm audit` still lists next advisories fixed only in 15.5 or 16, a
  major upgrade not made yet.
- The database: `scripts/db-lockdown.sh`, which the owner runs, gives the
  database role a long random password and publishes `boardofserv-db` on
  127.0.0.1:5433 only; until it has run, the container listens on every
  interface with the default password. `npm run db:up` now creates a new
  database on 127.0.0.1 only. How and when to run it:
  [docs/DEPLOY-PIER.md](docs/DEPLOY-PIER.md#lock-down-the-database).
- Not yet: Privy's HttpOnly cookies are off (Privy dashboard setting), kept
  off for now, so Privy keeps its access token where page scripts can read
  it. The server already accepts the `privy-token` cookie as well as the
  bearer header (`src/lib/auth-route.ts`).
- Backups go to `~/.boardofserv/backups/` (folder 0700, files 0600), outside
  the repo and any synced folder. The lockdown script takes one before it
  changes anything; the runbook has the commands to take and restore one.

## The model behind the chat

`src/lib/model.ts` holds an ordered list of OpenAI-compatible providers: SERV
Reasoning (`https://inference-api.openserv.ai/v1`, model `claude-haiku-4.5`,
`SERV_API_KEY` as a bearer token) first, then Dolphin (`DOLPHIN_API_KEY`,
model `deepseek-ai/DeepSeek-V4.1-Flash` by default), then the backup from
`FALLBACK_*`. Replies stream from whichever answers first. A published
helper's uses go to SERV only, since only SERV knows its Prompt Guard.

Dolphin's model reasons before it answers, and its reasoning counts against
the token cap: with a small cap, as on the plan call, it can spend all of it
reasoning and send back no text, which counts as an empty reply. Dolphin
reports usage when asked (`stream_options.include_usage`).

- Before the first token, a network error, a timeout, a 5xx, a 429, a 402 or an
  empty reply moves on to the next provider. Each provider is tried once per
  reply, so a 402 (out of credit) is never retried. Any other refusal stops.
- After the first token nothing is retried. The reply ends with "Reply cut off.
  Try again."
- If nothing answers, the thread says "Replies aren't available right now.
  Try again in a few minutes." What happened (which provider, which status)
  goes to the server's log only. Someone on their own SERV key is told when
  SERV refused it or it ran out of credit, since they can fix that. There is
  no fake reply.
- No reply or helper answer shows an em dash: each is replaced as it streams
  (`src/lib/dashes.ts`), with a comma between words, a hyphen between numbers
  or at the start of a line, and nothing before punctuation or a line's end.
  Code blocks and inline code are left as they are. Replies stored before
  this are shown the same way.
- Every request carries a system message, and json schemas lose their numeric
  range keywords: the rules SERV enforces. The chat switches no paid add-on on
  (no Prompt Guard, Shadow Agent or Kronos). A published helper's use declares
  `serv_prompt_guard` per request, to SERV only; nothing turns SERV's content
  filter off.
- Every stored reply records which provider answered, and the UI labels it.

Usage stays low: one short system prompt (`src/lib/systemPrompt.ts`) plus the
last 12 messages (older history is dropped, not summarised), and replies capped
at 700 tokens. Each reply writes one `reply_usage` row: conversation, the
person it was for, provider, model, prompt and completion tokens when
reported, the plan call's tokens, provider and model, time to first token,
total time and outcome (ok, fell back, failed). Publishing writes one for its
compile call (kind `compile`), and each helper use one `helper_uses` row with
its provider and model. None of them stores message text.

### Spend limits

`src/lib/spend.ts`. Days run midnight to midnight UTC.

- Each person may send `CHAT_DAILY_LIMIT` messages a day (default 30): every
  chat turn counts (a new message, an edit or a regenerate) unless it failed,
  counted from `reply_usage`, so deleting a conversation gives none back. Under
  10 left, a quiet line under the composer says how many; at none, the composer
  says when they come back.
- The site may spend `DAILY_SPEND_LIMIT_USD` a day (default 5) on the
  operator's keys. Spend is an estimate: the tokens every reply, plan call,
  compile call and helper use recorded, priced per model by `*_PRICE_*`.
  Once it is reached, chat, publishing and helper uses pause for everyone with
  "boardofserv has hit today's limit. It resets at midnight UTC." /admin shows
  today's spend against the limit.
- Someone using their own SERV key has no daily message limit, is never
  paused, and nothing they do counts towards the site's spend (`own_key`).
- A refused turn is refused before anything is stored, and its text goes back
  into the composer.

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

A one-shot answer helper is the default: the plan picks a watcher or a digest
only when the person mentions something to monitor or a schedule, and a sketch
the plan names no kind for is an answer helper. The dock has a small kind
switch (answer, watcher, digest, helper) the maker can change
(`PATCH /api/conversations/:id/sketch`); once they do, the plan keeps their
choice (`kind_chosen`). A helper on the board keeps its kind until it is taken
down.

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

## Handles

Every user has a handle, their public name, shown with an @: 3 to 20 lower
case letters, digits and underscores, unique ignoring case, and none of a few
reserved words (admin, board, serv, boardofserv, support, help). A new user
gets a random one like `maker_4821` until they choose their own; migration
0008 gave existing users theirs the same way. The account menu shows it under
"Your handle", edited in place with live availability checking. While it is
still the random one, the publish sheet asks the maker to keep it or choose
their own.

- `GET /api/account/handle?handle=`: whether a handle is free (signed in;
  your own counts as free).
- `PATCH /api/account/handle`: set yours.

## Publishing helpers

When an answer helper's fields are all set, the dock's switch becomes a
Publish button (other kinds keep "Switching on comes in the next update").
Publish opens a confirm sheet: the public name, a one-line description (up to
160 characters, shown in full on the board and the helper's page) and a "what
to type" hint the maker can edit, and a note that their instructions stay
private. While the maker's handle is still the random one, the sheet asks them
to keep it or choose their own, and says "We picked this one at random" only
while the field still holds it. Confirming runs one compile call (strict json_schema, `COMPILE_MAX_TOKENS`,
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
logs them. Makers are known by their handles: no part of anyone's email
reaches a page, an API response or a log, except the signed-in user's own
email in their account menu.

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
(`src/lib/leakGuard.ts`). If it carries the helper's canary (any eight of
its letters and digits in a row, even split by spaces), or 12 or more
consecutive words of its system prompt (compared ignoring case and
punctuation), the stream stops and the page shows "This helper can't share how
it works." To catch that before any of it shows, the guard holds back the
word still arriving and any tail of the answer that could be the start of
such a run, usually a word or two.

Until payments exist, uses run on the operator's key with a per-user limit:
`HELPER_DAILY_USES` (default 20) a day across all helpers, counted midnight to
midnight UTC. A use counts from the moment it starts, so uses running at the
same time cannot pass the limit; one that gave no answer stops counting when
it fails, and one cut off part way still counts. The page shows the
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
line carries either, or any part of anyone's email (apart from the account
menu's response to its owner).


## Agents

An agent runs on its own: on a schedule, when a value it checks changes, or
when a message comes in. A maker builds one in the chat, SERV plans it,
Dolphin writes its code, SERV reviews that code, and the maker tries it on
a test bench before publishing a version.

### The agent format

`src/lib/agents/definition.ts`: one versioned definition (`format: 1`),
checked with zod.

- `job`: what it does and what counts as done.
- `triggers`: a schedule (every hour, day or week, at a time), a value
  checked every so many minutes, or an incoming Telegram message. Stored
  now, run in a later phase.
- `settings`: the questions each renter answers at setup (label, type, help).
- `rules`: the limits a renter may adjust, each with the maker's default (a
  spend cap in USDC, an approval threshold, an allowed list).
- `memory`: named values kept per renter between jobs.
- `steps`: each with an id, title, kind, inputs, outputs and where it goes
  next. A code step carries a plain description of what its code must do and
  the tools it may call; a decision step carries a prompt for SERV and two to
  six outcomes, each with its own next step; an action step takes one
  declared action. A run starts at the first step.
- `actions`: the only actions the agent may ever take. A step may use a
  tool with a side effect (`sheets.write`, `telegram.send`, `telegram.ask`,
  `wallet.pay`) only when an action declares it.
- `limits`: the most steps, seconds and model spend (US dollars) one job
  may use.

Steps pass values through one bag per run: `settings`, `rules`, `memory`
and `trigger` are in it from the start, and each step adds its outputs. The
checks beyond the shape: names are unique, every next step exists and every
step can be reached from the first, every input comes from somewhere, action
steps take declared actions, and side effects are declared.

Agents live in `agents` (owner, the conversation it was built in, name) and
`agent_versions` (number, state, definition, code, bench data, build state).
An agent has at most one draft. Publishing turns the draft into a version
that never changes again: every write to a version is guarded by
`state = 'draft'` (`src/lib/agents/store.ts`), and editing after that starts
a new draft copied from the newest published version.

### The toolbox

`src/lib/agents/toolbox.ts`: the only things a code step can reach, through
the sandbox's host bridge, and only the ones its step lists.

- `sheets.read({ sheet })` and `sheets.write({ sheet, rows, mode })`
- `web.fetch({ url })` and `web.search({ query })`
- `telegram.send({ text })` and `telegram.ask({ question, choices })`, which
  asks the owner and waits for the answer
- `memory.get({ key })` and `memory.set({ key, value })`
- `wallet.pay({ to, amountUsdc, memo })`

Each has typed arguments, checked whatever the code sends, and a result
shape, written out as declarations for Dolphin. Real implementations come in
later phases. For now each is a mock that answers from the test bench's
sample data (sheets and their rows, pages, search results, the owner's
answers, memory, a wallet balance in USDC), on a copy per run, and logs
every call.

### The agent builder chat

"agent" is a sketch kind beside the one-shot answer helper. The plan picks it
when what the person describes runs on its own (on a schedule, watching data,
acting over time), and the dock's kind switch can pick it too. The plan only
chooses answer or agent now; watcher, digest and helper stay for sketches
that already have them.

SERV interviews the maker one question at a time, with answer buttons where
they help, through the same plan-then-reply turn as a helper: what wakes it
up, where it looks, what it does with what it finds, what counts as done,
what it must never do without asking, what the owner sets up and what it
should remember (`wakes`, `looks`, `handles`, `finish`, `asks`, `setup`,
`remembers` on `agent_sketches`, migration 0019). They ride in the same plan
schema as the helper's fields, so a first message that already says "every
morning, check my stock sheet" keeps what it said.

The agent's dock (`src/components/chat/AgentDock.tsx`) shows the interview
as seven chalk dots, filled as they are answered and turning while asked,
and once the agent is planned, its real steps as a chalk diagram
(`src/components/agents/StepDiagram.tsx`): a code step is a square, a
decision a diamond, an action a circle, with links to each next step and one
per outcome from a decision. New steps are chalked on one after another and
their links drawn with anime.js; a step whose code is approved fills in.
Helpers keep their takes / does / gives dock.

## Payments

Users top up a balance in USDC or $SERV, pay for helper uses from it, and
makers withdraw what they earn. Testnet (Base Sepolia) first.

Money is always an integer count of a token's smallest unit, held as a
`BigInt` and sent over JSON as a string of digits (`src/lib/money.ts`). A
number never stands for an amount: every money function throws on one.

### Configuration

Payments stay off until `TREASURY_ADDRESS` is set. All of it is read from the
environment (`src/lib/payments/config.ts`) and the boot log says what is on,
what is off and why:

- `BOS_NETWORK`: `base-sepolia` (default) or `base`. Base mainnet also needs
  `BOS_MAINNET=1`, and then logs a warning at every boot. Without it,
  payments stay off.
- `BOS_RPC_URL` (optional): the RPC endpoint; blank uses the network's public
  one.
- `TREASURY_ADDRESS`: the wallet users deposit to and payouts come from.
- `TREASURY_PRIVATE_KEY`: server only, read only by the payout signer, and
  only needed to pay withdrawals. Never commit or log it.
- `USDC_TOKEN_ADDRESS`, `USDC_DECIMALS`, `USDC_ENABLED`: USDC defaults to
  Circle's address for the network
  ([Circle's list](https://developers.circle.com/stablecoins/usdc-contract-addresses)),
  6 decimals, on.
- `SERV_TOKEN_ADDRESS`, `SERV_TOKEN_DECIMALS`, `SERV_ENABLED`: SERV stays off
  until the owner sets both the address and the decimals. OpenServ's docs
  ([the $SERV token page](https://docs.openserv.ai/what-is-serv/the-serv-token.md))
  list a Base address but no decimals and no testnet token, so the app never
  assumes either.

A database's balances belong to one network: the first time payments run,
the chain id and each currency's token address are written down
(`src/lib/payments/binding.ts`). Pointing the same database at another chain
later (Base Sepolia balances meeting Base mainnet, say) turns payments off,
and a currency whose token changed is turned off; use a separate database
per network.

### Ledger and balances

`ledger_entries` holds one row for every change to anyone's balance: user,
currency, a signed whole amount in minor units stored as a string, kind
(`deposit`, `use_charge`, `maker_earning`, `platform_fee`, `withdrawal`,
`withdrawal_reversal`), reference id, a unique idempotency key and the time.
Rows are only ever added. `balances` holds each user's available and held
amount per currency, changed in the same transaction as the ledger row
(`src/lib/payments/ledger.ts`). The database refuses a balance below zero,
an amount that is not a whole number, a debit kind with a positive amount (or
the reverse), and a second row with the same idempotency key. The platform's
fee rows have no user: that money stays in the treasury. For every user and
currency, the sum of their ledger rows equals available plus held.

### Deposits

A user tops up by sending USDC (or SERV, once it is on) to the treasury from
a wallet linked to their account. The embedded wallet counts as linked, and
the wallet page links an external one through Privy, which asks the wallet to
sign. The server only trusts the wallets Privy reports for the user
(`linked_wallets`, brought in step whenever the user opens their wallet page
or checks for a deposit), never an address the browser sends.

The deposit watcher (`src/lib/payments/deposits.ts`) reads each enabled
token's `Transfer` logs to the treasury from the block after the last one it
finished (`chain_cursors`, so a restart resumes there) to the newest block
with `DEPOSIT_CONFIRMATIONS` confirmations (default 5). A transfer from a
linked wallet credits that user once: the `deposits` row is unique per chain
id, transaction hash and log index, and so is the ledger row's idempotency key.
A transfer from any other wallet is recorded as unmatched, credited to
nobody, and listed on the admin page. Who sent it is decided by Privy when
Privy is set up (`getUserByWalletAddress`: the wallet must be linked to the
user right now), and the stored copy is updated from the answer; if Privy
can't be asked, that range waits for the next scan. Every scan also reads the
last 120 blocks below where it stopped again, so a node that once answered
with stale, empty logs can't make a deposit be missed. Newer transfers show as confirming; one
a reorg takes away is marked dropped. Before crediting anything in a token,
the watcher checks the token's `decimals()` on chain against the config.

The watcher runs in the server every `DEPOSIT_SCAN_INTERVAL_MS` (default 30
seconds; `BOS_PAYMENTS_WORKER=0` turns the interval off), and the wallet
page's "Check for my deposit" runs it at once.

The interval's cycle (deposit scan, hold sweep, payouts) runs only in the
process holding the payments worker lock, a Postgres advisory lock on a
connection of its own, checked before each cycle. Two servers on one
database (a development server next to the deployed one) never run it at
once: the other skips its cycles. A production server keeps the lock between
cycles; a development server gives it back after each, and a production
server that finds it taken tries again after 3 seconds rather than a whole
interval, so a deployed service takes over in the gap after a development
cycle and keeps it, even when both tick in step. The lock is given back when a
cycle throws, and Postgres drops it when its process dies. The log says once
which process runs the cycles and once when one starts skipping them. A
payout asked for in a request is sent under the same lock, or left to the
process holding it. "Check for my deposit" scans outside the lock, which is
safe: crediting is keyed per transfer, so two scans that overlap credit once. On the first scan it starts at
the newest confirmed block, or at `DEPOSIT_START_BLOCK` when set;
`DEPOSIT_SCAN_CHUNK` (default 200) is how many blocks one log query covers;
Base's public RPC refuses a log query over more than 201 blocks with HTTP 413,
so raise it only with a `BOS_RPC_URL` that allows more.
The RPC endpoint is checked to be on the configured chain before any call.

The wallet page, at `/wallet` (linked from the account menu), shows the
balances, a currency picker, the network name in big letters, the treasury
address with a copy button and a QR code, a warning that the wrong network or
token loses the funds, the linked wallets, and recent deposits with their
status.

- `GET /api/payments`: whether payments are on, the network, the treasury
  address and the currencies (public).
- `GET /api/wallet`: the signed-in user's balances, linked wallets and recent
  deposits.
- `POST /api/deposits/check`: run the watcher now (at most every 10 seconds
  per user) and return the wallet.

### Paid uses

A maker sets a price per use for each currency payments take, on the publish
sheet and later from the agents popover (the price tag on a helper that is on
the board). An empty price, or 0, means that currency isn't accepted. A helper
with no price stays free to try and keeps the daily limit; a price in a
currency that is turned off is ignored. Paid uses don't count against the
daily limit. Prices show on the board cards and the helper's page.

On a paid helper's page the user picks the balance to pay from, and the price
and what is left show under the input. Before the model is called, the price
is moved from available to held in one transaction (`holds`, the balance check
and the hold together, so parallel uses can't spend the same money). After
the answer (`src/lib/payments/uses.ts`):

- a good answer captures the hold: `use_charge` on the user, `maker_earning`
  of 90% (rounded down) to the maker, `platform_fee` of the rest to the
  platform;
- a failed or blocked answer releases it;
- a sweep in the server releases holds older than ten minutes, for a use
  that never ended.

A hold leaves `held` once only, so it can't be both charged and given back.
A short balance gets a 402 before any model call. The page sends the price
it showed, and a use is only charged at that price: if the maker changed it
in the meantime, the use is refused (409) with the new price, which the page
then shows.

- `PUT /api/helpers/:slug/prices`: the maker sets prices, in minor units per
  currency (`null` or `"0"` stops accepting one).

### Withdrawals

The wallet page shows what a maker earned from their helpers and what is
available, per currency, and takes money out to one of their linked wallets
once the balance reaches the currency's minimum (`WITHDRAW_MIN_USDC`, default
5; `WITHDRAW_MIN_SERV`, which the owner sets: SERV withdrawals stay closed
until then). The amount is debited at once, with a pending row
(`src/lib/payments/withdrawals.ts`).

- Below `WITHDRAW_AUTO_MAX_<CURRENCY>`, and while the day's automatic payouts
  (UTC) stay within `WITHDRAW_DAILY_CAP_<CURRENCY>`, it is paid without
  approval. Otherwise it waits for an admin, who approves it or rejects it
  (rejecting gives the amount back). Both default to 0: every withdrawal waits
  for approval until the owner sets them, and an automatic limit without a
  daily cap stays off.
- Payouts are signed with `TREASURY_PRIVATE_KEY` (`src/lib/payments/signer.ts`,
  the only code that reads it, and only if its address is `TREASURY_ADDRESS`)
  and go out one at a time: the database refuses a second payout in flight.
  The nonce, the hash and the signed bytes are recorded under the
  withdrawal's idempotency key before anything is sent, and the payout is
  sent once. If it isn't mined within a minute it is sent again: the very same
  signed transaction, so the same nonce and hash.
- Once its block has `DEPOSIT_CONFIRMATIONS` confirmations it is paid; a
  reverted transfer posts a `withdrawal_reversal` that gives the amount back.
  If another transaction took its nonce, so it can never be mined, the admin
  page offers to mark it failed after ten minutes, which also gives it back.
- Before signing, the treasury must hold the amount and enough ETH for gas,
  and the node must be able to estimate the transfer; otherwise that payout
  waits (the log says why) and the next one in the queue goes instead, so one
  payout can never hold up the rest. An admin can cancel a queued payout that
  hasn't been sent, which gives the amount back.
- The nonce is the signer's next one on chain. Every earlier payout is mined
  (paid or reverted) before another goes out, so there is never a gap.
- The admin switch pauses every payout, resends included.

- `POST /api/withdrawals`: ask for a withdrawal (signed in): currency, amount
  in minor units, a linked wallet, and a key so a double submit is one
  withdrawal.

### Admin

`/admin` is for the users named in `ADMIN_USER_IDS` (boardofserv user ids or
Privy user ids, comma separated); everyone else gets a 404, and the account
menu links to it only for them. It opens with today's model spend against
`DAILY_SPEND_LIMIT_USD` and the accounts waiting to get in (approve or
reject). Then, per currency, the treasury's
balance on chain, the total owed (every balance plus withdrawals not yet
paid out), the difference (the platform's fees and anything unmatched; it
must never go below zero, and the page says so loudly if it does) and the
platform's fees. Below that: withdrawals waiting for approval (approve or
reject), unmatched deposits, payout history with transaction links (a queued
payout can be cancelled there, and a stuck one marked failed), and the switch
that pauses every payout,
which takes effect at the next payout step without a restart. Users appear by
handle only, except in the waiting list, which shows each account's email so
the admin knows who is asking.

- `GET /api/admin`, `POST /api/admin/pause`, `POST /api/admin/withdrawals/:id`
  (`approve`, `reject` to reject or cancel before it is sent, or `fail`),
  `POST /api/admin/access/:id` (`approve` or `reject` a waiting account).

### Payment tests

Every onchain part runs against a fake chain (`src/test/fakeChain.ts`): blocks,
ERC-20 balances, Transfer logs, nonces and a mempool of really signed
transactions it decodes. No test makes an RPC call: the real chain client
refuses to start under Vitest unless a test has put the fake in place.

- Ledger (`src/lib/payments/ledger.test.ts`, `uses.test.ts`): a key posts
  once, the database refuses a negative balance, parallel uses never go below
  zero, holds are released on failure and by the sweep, the 90/10 split gives
  the remainder to the platform, and every money function throws on a number.
- Deposits (`deposits.test.ts`, `wallets.test.ts`): a linked wallet is
  credited once, an unlinked one recorded and not credited, the confirmation
  depth is respected, a restart resumes from the last block, a reorged
  deposit is dropped, and linked wallets come from Privy only.
- Withdrawals (`withdrawals.test.ts`): the minimum, the automatic limit, the
  daily cap, admin approval, reversal on revert, one payout in flight, a
  resend with the same nonce, the pause switch.
- Config (`config.test.ts`): SERV off without an address, mainnet off without
  `BOS_MAINNET=1`.
- Worker lock (`workerLock.test.ts`): two workers on one database, only one
  runs cycles and the other skips, logging that once; the lock is released
  when a cycle throws or its process dies; a development server hands over
  to a deployed one, also when both tick in step. An advisory lock belongs to a database session and PGlite has only
  one, so these run against a real Postgres named by `TEST_POSTGRES_URL` (CI
  starts one; locally they are skipped without it). For example:
  `docker run -d --rm --name bos-locktest-pg -e POSTGRES_PASSWORD=locktest -p 127.0.0.1:55432:5432 postgres:16-alpine`,
  then `TEST_POSTGRES_URL=postgres://postgres:locktest@127.0.0.1:55432/postgres npm test`.
- Routes: paid uses, the wallet, deposit check and withdrawal routes, and the
  admin routes. `src/test/secrecy.test.ts` also runs payments end to end and
  fails if any response or log line carries the treasury key, an email, a
  helper's prompt or its canary.

### Testnet smoke test

`scripts/testnet-smoke.ts` (`npm run testnet-smoke`) is for the owner to run
by hand. It runs on Base Sepolia only: it refuses any other `BOS_NETWORK`, any
`BOS_MAINNET`, and an RPC endpoint that is not chain 84532. It checks the
treasury's test USDC and ETH, prints the deposit address, waits for one USDC
deposit from `SMOKE_FROM` (the linked wallet the owner sends from; no one
else's deposit counts), credited by the app's own watcher, then sends one
tiny withdrawal back to that wallet through the app's own payout path. It
prints transaction hashes, never a key, a database address or an RPC address.
No test or CI run ever makes a real chain call; this script is the only thing
that sends a testnet transaction.

1. Make a testnet-only treasury and append it to `.env.local` without showing
   the key on screen (never reuse a key that holds real funds):

   ```sh
   node -e 'const a=require("viem/accounts");const k=a.generatePrivateKey();console.log(`TREASURY_PRIVATE_KEY=${k}\nTREASURY_ADDRESS=${a.privateKeyToAddress(k)}`)' >> .env.local
   grep TREASURY_ADDRESS .env.local
   ```

2. Give the treasury a little Base Sepolia ETH for gas from one of the faucets
   Base lists at https://docs.base.org/base-chain/tools/network-faucets (for
   example the Coinbase Developer Platform faucet).
3. Start the app on its database (`npm run db:up`, `npm run db:push`,
   `npm run dev`), sign in, open `/wallet` and link the wallet you will send
   from with "Link a wallet" (MetaMask or any wallet set to Base Sepolia).
4. Get test USDC into that wallet from Circle's faucet,
   https://faucet.circle.com: pick USDC and Base Sepolia and paste the
   wallet's address. It also needs a little Base Sepolia ETH for its own gas.
5. Run `SMOKE_FROM=0xYourLinkedWallet npm run testnet-smoke`. When it
   prints the deposit address, send about 1 USDC to it on Base Sepolia from
   that wallet.
6. It prints the deposit's hash when it is credited, then the payout's hash,
   and "The smoke test passed." once the payout has the configured
   confirmations. `SMOKE_WITHDRAW_USDC` sets the payout (default 0.01) and
   `SMOKE_TIMEOUT_MINUTES` how long it waits for the deposit (default 30).
7. Check `/wallet` (the deposit and the withdrawal) and `/admin` (the books,
   the payout in the history).
