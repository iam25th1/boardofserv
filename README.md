# boardofserv

Live at **https://boardofserv.25th.dev** (Base Sepolia), served from this Mac
by Pier: see [docs/DEPLOY-PIER.md](docs/DEPLOY-PIER.md).

Build an agent with SERV Reasoning at its core and rent it out. Or rent one
that's already working. The public landing page is at `/` (with `/about`,
`/terms`, `/privacy` and `/support`); the app lives under `/app`.

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
- `AGENT_PLAN_MAX_TOKENS` (optional, default 3500), `AGENT_PLAN_TIMEOUT_MS`
  (120000) and `DOLPHIN_CODE_TIMEOUT_MS` (240000): how long SERV's plan of an
  agent may be and take, and how long Dolphin may take to write one code step.
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
  the script and `cloudflareinsights.com` for connections. Production also
  sends `Strict-Transport-Security` (two years, with subdomains, not
  preloaded) and a `Permissions-Policy` that turns off the camera,
  microphone, location, payment requests, USB and ad topics.
- `/_next/image` answers 404 (`images.unoptimized` in `next.config.mjs`):
  nothing uses next/image, and next 14's image optimizer has advisories
  only next 16 fixes.
- Every route anyone can reach without signing in is rate limited per
  address (`src/lib/rateLimit.ts`, Cloudflare's `cf-connecting-ip` first):
  a fixed window a minute, then a 429 with `Retry-After`. Signed-in routes
  have their own per-account limits. Every admin route checks for an admin
  on the server (`src/app/api/admin/guard.ts`); a test finds them on disk.

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

- Before the first token, a network error, a timeout, a broken stream, a 5xx,
  a 429 or an empty answer (no content, or for a JSON call an answer that
  isn't JSON) is tried again on the same provider, three tries in all, 0.5 s
  and then 1 s apart (`MODEL_RETRY_ATTEMPTS`, `MODEL_RETRY_BACKOFF_MS`), and
  then moves on to the next provider. A 402 (out of credit) is never tried
  again: it moves straight on. Any other refusal stops.
- Each call says what it is for, and sends that purpose's answer limit
  (`src/lib/modelLimits.ts`), sized to what the answer needs: SERV checks
  credit against the limit sent, not what is used.
- Every try is logged (`model_attempts`: purpose, provider, status, time,
  tokens, which try, empty or not), and the admin's model cost view shows
  each purpose's empty answer and retry rates.
- A listing, request or offer that screening got no answer for is screened
  again by the worker, 2, 10 and 30 minutes later, before it waits for a
  person in the admin queue.
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
- `actions`: the only actions the agent may ever take, each with a tool that
  changes something (`sheets.write`, `telegram.send`, `telegram.ask`,
  `wallet.pay`, `memory.set`); reading and working things out happen in code
  steps. A code step may use a tool with a side effect only when an action
  declares it.
- `limits`: the most steps, seconds and model spend (US dollars) one job
  may use.

Steps pass values through one bag per run: `settings`, `rules`, `memory`
and `trigger` are in it from the start, and each step adds its outputs. The
checks beyond the shape:

- names are unique, every next step exists and every step can be reached
  from the first;
- every input comes from somewhere, and is made on every way to the step (a
  value made on only one branch of a decision can't be read where the
  branches meet);
- a step whose words name a setting, rule or memory key reads that bag;
- action steps take declared actions, and side effects are declared;
- an action whose tool needs exact arguments (`sheets.write`, `wallet.pay`,
  `memory.set`) takes them as its first input, a value of its own made by a
  code step for it alone.

Most of these came from building the example agent live (see below): each
is a way a plan from SERV passed the shape and still couldn't run.

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
shape, written out as declarations for Dolphin. On the test bench each is
a mock that answers from the bench's sample data (sheets and their rows,
pages, search results, the owner's answers, memory, a wallet balance in
USDC), on a copy per run, and logs every call. Running for real, the same
calls reach the owner's Google Sheets, Telegram, the web and Brave's search
(see Running for real and Connections); only the wallet is still a stand-in.

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

### Planning

Plan on the agent's dock (`POST /api/agents` with the conversation) makes the
agent and its first draft, or plans its draft afresh, once the interview is
complete. SERV, and only SERV, turns the interview and the conversation
behind it into a whole definition (`src/lib/agents/plan.ts`, max tokens
`AGENT_PLAN_MAX_TOKENS`, default 3500). Its answer is the format flattened
for SERV's strict json_schema (every field present, "" or [] where it doesn't
apply, no unions, no numeric range keywords), turned back into the format
and checked. A plan that doesn't check out goes back to SERV with the
reasons, up to three tries in all. One mistake with only one meaning is
repaired on the way in: a step that lists a setting, rule or memory key as
an input (or names one in its words) reads the bag it lives in. A whole plan
is one answer of a few thousand tokens, not streamed, so it waits up to
`AGENT_PLAN_TIMEOUT_MS` (default 120000) rather than a reply's 20 seconds;
a review waits a minute and a decision half a minute. Decision steps carry a prompt and their
outcomes, action steps one declared action, code steps a plain description
of what the code must do with its inputs and outputs.

Planning, and the code after it, runs in the background
(`src/lib/agents/build.ts`), one job per draft, since it can outlast a
request (Cloudflare closes a request after 100 seconds). The draft's
`build_state` says where it is (`planning`, `writing`, `fixing`, `idle` or
`failed` with a plain note), the dock polls `GET /api/agents/:id` every two
seconds while it builds, and a state no job in this process owns (the
server restarted) is called failed so the maker can plan again. Every model
call writes a `reply_usage` row (`agent_plan`, `agent_code`, `agent_review`,
`agent_decision`), so building counts towards the day's spend, and planning
is refused like a chat turn when the day's limit is reached or the account
isn't let in yet.

### Code writing and review

Once a plan is saved, each code step without approved code is written
(`src/lib/agents/code.ts`), one at a time:

1. Dolphin writes it as `async function run(input,
   tools)` against the toolbox's declarations for the step's own tools,
   told what each input holds (the renter's settings and rules by key and
   type, or the earlier step it comes from), what the agent is for, what
   to return, and the exact arguments any output must be when an action
   takes it as its tool's arguments. Settings
   from recon on Dolphin's API: `max_tokens` 4000, its reasoning off for
   the first draft (`chat_template_kwargs: { thinking: false }`, which it
   accepts though its docs don't list it) and on for a rewrite. If Dolphin
   ever refuses that field, the call is made again without it.
   `DOLPHIN_CODE_TIMEOUT_MS` (default 240000) bounds one call.
2. Plain checks, before any review: it parses (compiled with `node:vm`,
   never run), defines `run`, calls only its step's tools by name, and
   reaches for nothing outside the sandbox (require, imports, fetch,
   globals, timers, building code at run time, prototype tricks).
3. SERV reviews it (strict json_schema, approve or reject with a reason):
   does it do what the step says with exactly its inputs and outputs, does
   it touch only the declared tools, does it do anything risky.

A failed check or a rejection goes back to Dolphin with the reason, up to
three rounds. After that the step "needs attention" in the builder, with the
last reason and the last code. When Dolphin fails or times out twice on the
same step (no answer at all), SERV writes that step from the same request
instead, for the rest of its rounds; the plain checks and SERV's review run
as before, the review in a separate call. The step is marked "written by
SERV" in the builder, and the admin page counts how often that happened. The code is stored with the version
(`agent_versions.code`), and only the maker's own builder ever shows it.
Dolphin's calls are on the site's key whoever builds; SERV's on the
maker's own key when they have one.

### The sandbox and the test bench

Code steps run in QuickJS compiled to WebAssembly
(`src/lib/agents/sandbox.ts`, `quickjs-emscripten-core` with its prebuilt
release build: no native step to install), a fresh runtime for each step.
It has no network, no files, no modules and no timers. The step's code sees
its input as JSON and a frozen `tools` object whose functions call one host
function, the bridge, with a tool name and JSON arguments, and get JSON
back; the bridge lets through only the tools the step lists, and the
toolbox checks the arguments. Only strings cross, so no prototype trick
inside can reach the host. Five seconds (an endless loop is interrupted),
32 MB and a small stack bound each step; deep recursion stops inside
QuickJS as a plain error, and any fault on the host side drops the wasm
instance rather than trusting it again. The packages are loaded from
`node_modules` at run time (`serverComponentsExternalPackages`), since the
runtime reads its `.wasm` file from its package.

The test bench is on the agent's builder page, `/agents/:id`, for its
maker only. The maker edits sample data for every tool's mock (sheets and
their rows, pages, search results, the owner's answers, memory, a wallet
balance, the settings and rules a renter would have) and runs the agent
(`POST /api/agents/:id/run`, streamed). Each step lights up on the diagram
and in the trace as it happens, with its input, output, tool calls, time
and cost (`src/lib/agents/runner.ts`). Decision steps ask SERV, within the
agent's spend limit; a dry run takes the recorded answers instead and calls
no model. An action step is taken with its first input when that is
already the tool's arguments; a message to the owner is made from any
inputs. The run stops at the end, at the first failure or at the agent's
limits on steps, time and spend, and says which.

Fix by chatting (`POST /api/agents/:id/fix`): the maker says what went
wrong ("it ignored delivery time"), SERV changes the plan from the plan as
it is, and only the code steps whose job changed are written and reviewed
again; the rest keep their approved code.

### Saving and versions

On the builder: Save draft keeps the test bench's sample data with the
draft (`PUT /api/agents/:id/bench`); Publish version
(`POST /api/agents/:id/publish`) turns the draft into a version that never
changes again, once it is planned, done building and every code step's code
is approved. The Versions list shows each one, published or draft. A
published version shows as "in testing" on the maker's own agents page,
`/agents` (`GET /api/agents`, linked from the account menu); it doesn't go
on the board for renting yet. Changing the plan or saving the bench after
publishing starts a new draft copied from it.

### Running for real

An installation (`src/lib/agents/runtime/`) is one owner's running copy of a
published version: their answers to its settings questions (a form made
from the questions, checked in the browser and on the server), their rule
values over the maker's defaults, what it remembers for them, its time zone,
schedule time, minimum gap between jobs and daily model spend cap, and its
status. For now a maker installs their own agent from the builder with "Run
it for real" (`POST /api/agents/:id/installations`); `install()` takes any
owner, for renting later. Google Sheets, Telegram, web search, memory and
`web.fetch` are real; the wallet is still a stand-in (copied from the
version's test bench, kept per installation).

Setting one up is a guided flow: its questions, Telegram linked (when the
agent messages or asks its owner), Google connected and each sheet picked
(when it works on sheets), its rules and limits, then a test run. It is
installed as `testing`: nothing starts it but a test run by hand, which
does everything once for real and is drawn step by step; "Make it live"
starts its triggers. Installing needs the connections the agent uses.

- Triggers: a schedule fires in the owner's time zone ("every day at 7:00",
  daylight saving kept to the wall clock); a value check runs its own code
  step every so many minutes and starts a job only when its condition turns
  true; a message from the installation's in-app message box starts a job
  with the message as its input.
- Jobs are rows (`agent_jobs`): queued, running, waiting_for_owner, done,
  failed or cancelled. The worker runs in the server process (`boot.ts` says
  why) under its own Postgres advisory lock, the payments worker's way, and
  claims jobs atomically, one running per installation (the database holds
  to that too). A job saves where it is after every step and tool call, so
  after a pause or a restart the step runs again with its earlier tool calls
  replayed from its journal, never made twice. Failures outside the agent
  are tried again after 30 seconds, 2 minutes and 10 minutes; the agent's own
  logic failing is not. A job keeps its version to the end.
- Approvals: `telegram.ask`, and spending over a limit, pause the job and
  open a question with each answer's effect (a count in the top bar,
  `/approvals`, and the owner's Telegram chat with a button per answer:
  whichever answer comes first counts, and the other one then shows it). It
  expires after the maker's `approvalHours` (24 by default) and the job
  takes the step's `otherwise` path, or stops.
- The spending guard (`runtime/spend.ts`): spending is a payment
  (`wallet.pay`), or rows written by a `sheets.write` action that names an
  `amountColumn` (orders). Before any of it goes through, it is added to
  the job's running total and to the installation's total for the day (the
  owner's day), and checked against every `askOver` (per job) and
  `askOverDay` (per day) limit the agent declares, at the owner's values,
  whatever the agent's own steps decided. Five payments of 40 against a
  limit of 50 ask before the second one.
- Memory is kept on the installation, only the declared fields and types.
- `web.fetch` (`webFetch.ts`) is GET only, http and https, 1 MB, 10 seconds,
  text types, HTML read as text, and refuses private, loopback, link-local,
  metadata and reserved addresses, after DNS and every redirect too. Its text
  is marked untrusted, and decisions show it to SERV as data, never
  instructions.
- Every step is logged with its input, output, tool calls, time, model and
  cost (`/jobs/:id`, drawn step by step). The owner sees everything; the
  maker sees how it ran on someone else's copy and none of their data.
  Limits per job (steps, seconds, spend) and the installation's daily cap
  fail a job with a plain reason, and its spend counts towards the site's
  daily limit.
- `/installations` gives the owner status, next run, recent jobs, waiting
  questions, spend today, and run now, pause, resume and stop (queued jobs
  cancelled, a running job stopped after its current step).

`BOS_AGENT_WORKER=0` turns the worker off in a process, and
`AGENT_FETCHES_PER_DAY` (default 100) caps each installation's pages a day.

### Connections

Owners connect Telegram and Google once, on `/connections`
(`src/lib/connections/vault.ts`). Each connection's secret (a Telegram chat,
Google tokens) is kept encrypted like the OpenServ keys, decrypted on the
server only for the call that needs it, and never reaches agent code, a
maker, a log line or a response: the owner sees a label (`@name`, an email
address) and dates. A Telegram chat is found by a keyed hash, and links to
one owner at a time. Disconnecting revokes Google's access, forgets the
secret, and pauses every installation that needs it with a plain reason; it
can't resume until the connection is back.

- Telegram (`src/lib/telegram/`): the owner gets a one-time code (kept as a
  hash, 10 minutes, once) and sends the bot `/start CODE`, or opens the
  `t.me` link that sends it. `telegram.send` goes to the installation
  owner's linked chat and nowhere else; questions go with a button per
  answer. Sending runs from the worker's cycle, each row its own outbox
  entry (five tries, Telegram's `retry_after` kept on a 429), so a job
  never waits on Telegram. Owners can message the bot: it goes to their one
  agent that takes messages, or the one they pick from a short menu. The
  webhook (`/api/telegram/webhook`) reads an update only with the secret in
  `X-Telegram-Bot-Api-Secret-Token`, checked against a hash in the
  database, and handles each update once. Nothing in the server changes
  the webhook: `scripts/telegram-webhook.ts` does, run by the owner after a
  deploy (it only shows the current webhook without `--apply`). In
  development, `scripts/telegram-fake-update.ts` posts made-up updates to a
  local server with `TELEGRAM_DEV_WEBHOOK_SECRET` (ignored in production),
  or, with `forward`, the bot's real updates (read with `getUpdates`, which
  Telegram answers only while the bot has no webhook).
- Google Sheets (`src/lib/google/`): the OAuth web server flow, scope
  `spreadsheets` (a pasted link isn't covered by `drive.file`), with
  `access_type=offline` and `prompt=consent` for a refresh token. The state
  is tied to the browser (an HttpOnly cookie) and the owner (a hash in the
  database), once, within 10 minutes; the callback is
  `/api/connections/google/callback`. A sheet setting is a pasted link:
  boardofserv opens it on the owner's access, they pick the tab, and the
  installation keeps a grant per setting. The sheet tools reach only those
  tabs, write values as they are (never formulas), refresh tokens on their
  own, and pause the installation when Google says the access was revoked
  (in Google's Testing mode it lasts 7 days). Each owner stays under 50
  calls a minute and each installation under `AGENT_SHEET_CALLS_PER_DAY`
  (500).
- Web search: Brave's Search API (`BRAVE_SEARCH_API_KEY`), plain text
  results marked untrusted like a fetched page, within
  `AGENT_SEARCHES_PER_DAY` (50) per installation and `SITE_SEARCHES_PER_DAY`
  (1000) for the site.

After deploying a version with these, the owner: sets `TELEGRAM_BOT_TOKEN`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `BRAVE_SEARCH_API_KEY` in
Pier, adds `https://boardofserv.25th.dev/api/connections/google/callback`
as the Google OAuth client's redirect URI (and themselves as a test user
while it is in Testing), runs `pier deploy boardofserv`, then, in the
deployed app's folder, the webhook script with `--apply`, then sets
`BOS_AGENT_WORKER` back on.

### The example agent

`src/lib/agents/examples/restock.json` is a fabric shop's restock agent,
built through the real pipeline by `scripts/seed-restock.ts` with live calls
(SERV planning, Dolphin writing, SERV reviewing and deciding):

```sh
npx vite-node --config vitest.config.ts scripts/seed-restock.ts
```

It reads the owner's Stock sheet (a Google Sheet tab) and the suppliers'
price page with `web.fetch`, picks the cheapest supplier within the longest
delivery the owner allows, and, when SERV decides there is anything to
order, writes the order rows to the Orders tab and remembers it (otherwise
it tells the owner stock is fine). Writing the orders is spending (their
`total_cost_usdc` column), so the guard asks the owner on Telegram before
an order whose total is over their approval limit, and a no stops the job.
The suppliers' page (`examples/supplierPage.ts`, made-up neutral prices) is
served publicly at `/examples/suppliers`; tests and the demo serve it
themselves. The script needs `SERV_API_KEY` and `DOLPHIN_API_KEY`, touches no
database, refuses any call past its budget (`SEED_SERV_BUDGET`,
`SEED_DOLPHIN_BUDGET`) and lists every call with its status, tokens and
time. `SEED_RESUME=1` keeps the saved plan and approved code and writes only
what is missing; with `SEED_FIX="what went wrong"` SERV first changes the
saved plan, as fixing by chatting does. The decisions of one live run are
recorded on its bench, so dry runs replay them with no model call.

`/demo?agent=restock` (development only, no sign-in) shows its builder and
test bench: a run is a dry run on the server (`POST /api/demo/agent`, a 404
outside development), every tool a mock and every decision recorded, so it
never calls a model. Save draft and Publish only change that page.
`/demo?agent=restock&live=1` runs it for real on the real runtime, in an
in-memory Postgres inside the development server: installed for a test
owner, every 90 seconds, against a Google Sheet held in memory and a
suppliers' page the demo serves itself, with a stand-in for SERV, so it
needs no database and no keys. `scripts/live-restock.ts` runs it as a job
with SERV deciding for real (`SERV_API_KEY`, `LIVE_SERV_BUDGET`, default 6
calls); with `TELEGRAM_BOT_TOKEN` and `LIVE_TELEGRAM_CHAT` it asks in that
real chat too. `scripts/live-enquiry.ts` runs the Enquiry follow-up live on
its test bench twice, the owner answering Yes and then No, with SERV making
its two decisions (`LIVE_SERV_BUDGET`, default 4 calls), and checks the row
each answer writes. A production
build has none of this (`src/test/demo-unreachable.test.ts` checks the
build).

## The market

### Routes

The landing page is `/`; it never redirects, and a signed-in visitor gets an
"Open the app" button. The app's pages moved under `/app`, and their old
addresses redirect there permanently (308), queries kept: `/chat` to
`/app/chat`, and the same for `board`, `agents`, `installations`,
`approvals`, `jobs`, `wallet`, `connections` and `admin`, each with every
path under it (`next.config.mjs`). Helper pages stay at `/h/[slug]`. Every
`/api` path stays where it was, above all the ones outside services call:
the Telegram webhook (`/api/telegram/webhook`), Google's callback
(`/api/connections/google/callback`) and `/api/health`.

New pages: `/app/board` (agents and helpers), `/app/board/agents/[id]` (an
agent's page), `/app/rentals` and `/app/rentals/[id]` (what you rent),
`/app/rentals/[id]/setup`, `/app/agents/[id]/dashboard` (the maker's view),
`/app/requests` and `/app/requests/[id]`.

### Listing and renting

From an agent's builder, once a version is published, its maker puts it on
the board for rent at a weekly price in USDC and, if they like, a fee per
job (`POST /api/agents/:id/listing`). The board (`GET /api/board`) lists
agents with what they do, what they connect to, their prices, how many rent
them, their maker and a quality and trust placeholder ("not enough reviewed
jobs yet"), filtered by connection, price and kind, with a search. An
agent's page (`GET /api/market/agents/:id`) shows its steps in plain words,
what it asks at setup, what it never does without asking and all it can
ever do: never its code, its prompts or its test bench.

Renting (`POST /api/market/agents/:id/rent`) charges the first week from the
renter's balance through the ledger the way a paid use is charged: held,
then captured, 90% to the maker and 10% to the platform. Each week is
charged once (`rental_charges`). The renter then sets it up with the guided
setup, as its owner (`POST /api/rentals/:id/install`), given only what setup
needs (name, questions, rules, schedule, connections). The worker's cycle
renews each week while the balance covers it; when it doesn't, the rental
is unpaid and its installation pauses with a plain message and a top-up
link, and resuming from the rental pays the week first. Cancelling stops
renewal at the end of the paid week. A fee per job is held before the job
first runs, captured when it finishes and released when it fails or is
stopped; test runs are free, and a balance that doesn't cover the fee fails
the job before it does anything (`src/lib/market/charges.ts`,
`rentals.ts`).

The renter's pages show its state and controls (run now, pause, resume,
cancel, keep renting), the paid week, the next run, questions waiting,
recent jobs with their timelines, and the money: this week's cost, spent so
far, fees set aside, and the renewal date (`GET /api/rentals`,
`GET /api/rentals/:id`, `POST /api/rentals/:id/control`).

### The maker's dashboard and versions

`GET /api/agents/:id/dashboard` (maker only): earnings by week (the maker's
share of rent and fees), renters by handle, renters' jobs finished in the
last 30 days, failures grouped by the step that failed (never by what the
job saw), versions and who runs each, and its runs for real with renters'
data hidden. Publishing a new version moves the board to it and offers it to
everyone renting an older one, on their rental page and in Telegram; each
updates or stays (`POST /api/rentals/:id/version`). An update keeps their
answers; a breaking one (a setup question added, removed or changed, or a
new connection) stops what runs and asks for setting up again.

### The request board

Anyone can browse `/app/requests`, most wanted or newest first. Signed in,
people ask for an agent (`POST /api/requests`: what it should do, details,
connections, a weekly budget), say "me too", and makers offer one of their
published agents with a note and a price (`POST /api/requests/:id/offers`).
The one who asked accepts an offer (`POST /api/offers/:id`), which rents
that agent at the offer's price, or closes the request.

### Limits

Invite-only covers renting, setting up, resuming, listing, asking, "me too",
offering and accepting. Each person's market actions a day (rentals, requests,
offers, "me too") are capped at `CHAT_DAILY_LIMIT`, counted on their own.
Once the site's day budget (`DAILY_SPEND_LIMIT_USD`) is spent, renting,
setting up, resuming, asking and offering pause like chat does, except on
one's own SERV key (`src/lib/market/limits.ts`).

### The examples on the board

Three examples go on the board free, owned by the first account in
`ADMIN_USER_IDS`: the restock agent, a morning sheet report (a short summary
of what changed in a sheet, on Telegram) and an enquiry follow-up (drafts a
reply to the oldest new enquiry in a sheet and asks before recording it as
ready to send). The two new ones were built through the real pipeline by
`scripts/seed-examples.ts` (`SEED_EXAMPLE=sheet-report` or
`lead-followup`, with the same budgets and call list as `seed-restock.ts`).
`scripts/import-examples.ts` puts all three on the board from their saved
files, with no model call; running it again changes nothing.

### Seeing it without a sign-in

In development, `/demo?market=board|agent|rentals|rental|maker|requests|request`
shows each market screen with sample data.

## Safeguards

### Risk levels and what asks first

Every tool has a risk level: looks things up (`sheets.read`, `web.fetch`,
`web.search`, `memory.get`), changes the renter's own data (`sheets.write`,
`memory.set`), sends a message (`telegram.send`, `telegram.ask`) or spends
money (`wallet.pay`) (`src/lib/agents/toolbox.ts`, `risk.ts`). The platform's
floor: a payment asks first above the renter's auto limit (0 USDC unless they
raise it, at most 1000), and so does anything sent or paid that carries a
link, address or contact detail the renter never gave the agent. Renters can
make any tool that changes or sends something ask them every time (the
installation page's "What it may do on its own", `PATCH
/api/installations/:id`); nobody can lower the floor. Each approval says why
it asks.

### SERV's guard on every action

Before anything that writes, sends or spends runs, SERV reads it with the
agent's purpose, the step, the renter's settings and what the step worked
from, and answers allow, ask or block with a reason
(`src/lib/agents/guard.ts`, structured output `action_guard`). Ask waits for
the renter with SERV's reason; block stops the step and says why. When SERV
can't be reached, can't be paid for today or the week's model budget is
spent, the answer is ask, never allow. The same call is checked once a run.

### Untrusted input

What an agent reads from outside (web pages, search results, sheet cells,
Telegram messages, memory, request posts) reaches a model only inside a
labelled data fence it can't close, with the rule that data is never obeyed
(`untrusted.ts`). Before a decision or code step reads any of it, a quick
local look and then SERV (with its prompt guard, `input_screen`) screen it;
anything that reads like instructions to the agent waits for the renter,
with the excerpt shown, and a no stops the job before it acts
(`screen.ts`). Verdicts are kept by hash, so the same text is screened once.

### Code review before publish

Every version is reviewed before it is published or offered to renters as
an update: plain checks on each code step (network outside the tools,
modules, the host's globals, code built at run time, constructors and
prototypes, encoded text, long blobs, endless loops; secrets, other accounts
and fixed web addresses as warnings), then SERV reads all of the code
against what the agent says it does (`vetting.ts`, `version_review`). A
blocking finding stops the publish and the maker sees the findings in plain
words; findings never quote code (anything copied from it is taken out).
When SERV can't review, publishing waits. The sandbox has no network, files,
modules or environment, stops after 2 seconds and reaches only the tools a
step was given.

### Model cost and budgets

Every model call a run makes (decisions, the guard, the screen) is metered
per installation, job and day, in tokens and USDC at the `*_PRICE_*_PER_M`
rates (`metering.ts`, `agent_model_usage`). Each installation has a weekly
model budget: the maker sets a default on the listing, the platform a
ceiling (`AGENT_MODEL_BUDGET_CEILING_USDC`, 5), the renter can change it
within the ceiling. A run that would go over it asks first. Free agents run
on a weekly allowance the platform pays for
(`AGENT_FREE_MODEL_ALLOWANCE_USDC`, 0.25) and pause with a plain message when
it is used up, until Monday or sooner on the renter's own SERV key. A maker
can pass model cost on to renters: each finished job's cost is charged on top
of the fee. The board shows a weekly estimate.

boardofserv's own SERV calls, outside any installation (code reviews while
an agent is built, the review before publishing, screening posts and
listings, screening outside a run), are metered the same way
(`platform_model_usage`) against the platform's daily budget
(`PLATFORM_MODEL_BUDGET_USDC`, 2): past it they wait as when SERV can't
answer, never skipped. Every call, installation or platform, counts toward
the site's daily limit. The admin's model cost view shows every call this
week by what it was for, and the platform's spend today against its budget.

### Schedules

Schedules run every N minutes, every N hours, every day at a time, or every
week on some days at a time, in the renter's time zone, never more often than
the platform's minimum (`AGENT_MIN_INTERVAL_MINUTES`, 15) whatever the plan
or the renter says (`schedule.ts`, `interval.ts`). The enquiry follow-up
example now wakes every 15 minutes.

### Limits per installation

Jobs an hour (`AGENT_JOBS_PER_HOUR`, 12), messages to its renter an hour
(`AGENT_OUTBOUND_PER_HOUR`, 20), actions in one job
(`AGENT_ACTIONS_PER_JOB`, 40), visits to the same step in one job
(`AGENT_STEP_VISITS`, 12), and jobs in a row failing the same way
(`AGENT_SAME_FAILURES`, 3). Past one, the installation pauses with a plain
message saying which (`runtime/rates.ts`).

### Kill switch and freezes

A maker can stop their agent everywhere at once from its dashboard
(`POST /api/agents/:id/kill`): every installation pauses with a message to
its renter, renewals and new rentals wait, and starting it again adds the
stopped time back to every paid week. An admin can freeze an agent, a
version, a maker or a renter with a reason (`POST /api/admin/freezes`, lift
with `POST /api/admin/freezes/:id`): a frozen thing can't run, be rented,
publish or offer. Whatever pauses an installation, the step running now
finishes and nothing after it runs (`src/lib/safety/freeze.ts`).

### Reports and moderation

SERV screens new listings, request posts and offers for scams, harmful jobs
and other people's personal data before they go public (`content_screen`);
anything it holds, or can't screen, waits in the admin queue and is seen only
by whoever posted it. A held listing can't be rented and a held offer can't be
accepted. Anyone signed in can report an agent, its maker, a request or an
offer with a reason and a note (`POST /api/reports`, once per thing, ten a
day). Admins work the queue on `/app/admin/safety`: approve, hide or freeze,
each with a reason (`POST /api/admin/moderate`, `src/lib/safety/moderation.ts`).

### Audit log

Every guarded action gets an append-only line: what ran (or was asked,
declined, blocked, stopped by a limit, or failed), SERV's check and its
reason, who approved it, the check's model cost and any USDC spent
(`agent_audit`, `src/lib/agents/audit.ts`, the only file that touches the
table; a database trigger refuses updates and deletes). Renters see all of
theirs on the installation page (`GET /api/installations/:id/audit`); makers
see every installation of their agent on its dashboard, renters by number
and their data hidden (`GET /api/agents/:id/audit`); admins see everything
(`GET /api/admin/audit`).

### Seeing it without a sign-in

In development, `/demo?safety=approval|review|budget|kill|held|queue|audit`
shows each safeguard's screen with sample data.

## Quality: Reppo

[Reppo's Eval Router](https://eval.reppo.xyz/agents.md) scores what agents
do. It is a second opinion for people to read: it never allows, approves
or blocks an action on its own. With `REPPO_API_KEY` unset it is off and
everything else works as before.

### What Reppo is shown

Submissions are treated as public. An evaluation's input is built only
from what is public already (an agent's published purpose, step titles,
the outcomes its decisions can pick, what its actions are for) and words
fixed in `src/lib/reppo/redact.ts` (what started the job, which steps ran,
which actions ran, what SERV's safety check said, who let them run, how it
ended). Never a renter's name, contacts, answers, sheets, messages,
memory, amounts, wallet addresses, links or ids, nor the agent's code or
prompts; a last pass takes out anything that looks like one, and every
value the renter gave it. The input stored on `reppo_evals` is exactly
what was sent.

### Scoring jobs

The worker's cycle (beside the jobs, never in their way) samples finished
jobs sparsely: the first few of each new version (`REPPO_FIRST_JOBS`, 3),
then one in N (`REPPO_SAMPLE_EVERY`, 10), at most so many a week for each
agent (`REPPO_AGENT_WEEKLY_CAP`, 10), free examples included, and never past
the site's daily credit budget (`REPPO_DAILY_CREDITS`, 4400: ten
evaluations at 440 credits). It submits them (`POST
/api/v1/agents/evals`, task type `action`), reads each back from 30
seconds on with growing gaps, and records the score, route, reason and
rubric scores. One row per job or approval, so nothing is scored twice.
Reppo slow, down, out of credits or refusing the key never touches a job:
the failure is recorded and tried again later, a few times; a 401 or 402
stops submissions for an hour. Admins see credits used today and this
week, what is in flight and waiting, and the settings on
`/app/admin/safety`.

### Second opinions

A payment, or something sent to a contact the renter never gave the agent,
that already waits for the renter's yes also gets a Reppo action
evaluation, queued beside the wait (`REPPO_ACTION_OPINIONS=0` turns this
off). The approval card shows "still being checked" until it comes, then
the score, the route in words and Reppo's reason; Telegram's question says
one is coming, and it follows in the renter's chat while the question
waits. The renter's answer is always the decision; a late or missing
opinion never holds anything up (`src/lib/reppo/opinion.ts`).

### Quality score

Each version's rolling score from its latest scored jobs
(`REPPO_SCORE_WINDOW`, 30), shown once enough were reviewed
(`REPPO_MIN_SCORED`, 5), otherwise "not enough reviewed jobs yet", with
how many were and the share routed ship, review and block. A new version
starts fresh and shows the previous version's score as history. Board
cards and agent pages show it; the board sorts by it (`?sort=quality`) and
filters by it (`?quality=N`). The maker's dashboard lists each scored job
with its score, route, reason and rubric scores, with nothing of the
renter's (`src/lib/reppo/quality.ts`).

### Blocks and holds

A job Reppo routes to block is flagged on its maker's dashboard and waits
in the admin queue with Reppo's reason; admins approve, hide the listing
or freeze the version. Several blocks on the listed version within a
window (`REPPO_HOLD_BLOCKS`, 3, within `REPPO_HOLD_DAYS`, 7) put its listing
on hold: off the board until an admin looks, its renters told in plain
words, their installations running as before with their pause button
(`src/lib/reppo/blocks.ts`).

## The beta

boardofserv is a beta on test USDC on Base Sepolia, and says so: a beta tag
beside the mark on the public pages and in the app, a line under the front
page's hero, and "test USDC on Base Sepolia" wherever money shows (wallet,
spending, payment approvals). About, Using the beta (`/terms`) and Your data
(`/privacy`) are short plain notes with no legal or business words (a test
checks a list of them); Support takes Telegram and, once the owner sets
`SUPPORT_EMAIL`, email. Links shared anywhere show a chalk card
(`public/brand/share-card.png`, from `docs/brand/share-card.html`), and an
agent's page shares with its own name and what it does.

For later, as docs only: [docs/MAINNET.md](docs/MAINNET.md) (what to work
through before real money), [docs/HOSTING.md](docs/HOSTING.md) (running on
the owner's Mac, plainly), [docs/GOOGLE-VERIFICATION.md](docs/GOOGLE-VERIFICATION.md)
(the owner's steps for Google's review). Backups: `scripts/backup-db.sh`
(see [docs/DEPLOY-PIER.md](docs/DEPLOY-PIER.md#back-up-the-database)).

## Trust and spending

Agents pay saved payees from an allowance their renter funds, on Base
Sepolia in test USDC, from the treasury. Every payment is held, sent once,
confirmed, receipted and reconciled with the chain. Every agent version
and maker has a trust score from 300 to 850, a fixed formula (never a
model's opinion), and the score caps how much an agent may pay without
asking. No Kite and no third party payment rails.

### Allowance and payees

Each installation has an allowance (`src/lib/spending/allowance.ts`): the
renter moves USDC into it from their balance and takes it back whenever
they like (`AGENT_ALLOWANCE_MAX_USDC`, 100, the most it may hold). The
money stays in the renter's balance, held, until a payment spends it, so
the ledger's kinds don't change. An agent pays only payees saved on its
installation (`payees.ts`): a name and a checksummed Base address, never
the zero address, the treasury or the USDC contract. An address the agent
names that isn't saved becomes a suggestion: nothing is paid, and the
renter can save it on screen with a name of their own. The first payment
to an address always asks.

A payment is judged by its address, never the name it was saved under
(`addresses.ts`), so renaming a payee changes nothing about how its
payments are checked. The safety check is told the address, the amount,
how often this installation paid it and what is known about it, never the
label. An address that is the agent's maker's own wallet, boardofserv's
treasury, another maker's wallet, or saved by several other renters
(`PAYEE_CROWD_RENTERS`, 3) is high risk: a payment to it always asks, with
a plain warning, whatever the limits allow, and the renter's payee list
shows the warning.

### Payments on chain

`wallet.pay` (`pay.ts`) holds the amount in the allowance, then signs the
transfer from the treasury under a database lock, records its nonce, hash
and signed bytes before sending, sends, and waits for
`DEPOSIT_CONFIRMATIONS`. Confirmed, the hold is spent (a `use_charge` on
the ledger, key `agentpay:<id>`) and the receipt kept; reverted or stuck,
the hold is released. One action never pays twice: its key is the job and
the call, and after a crash the recorded transaction is sent again, never
a new one. One send leaves the treasury at a time, across agent payments
and withdrawals, so nonces never collide. Below
`AGENT_PAYMENTS_MIN_TREASURY_USDC` (5) of USDC left after a payment, or
without ETH for gas, payments pause site wide with an admin alert. Any
mainnet chain id, RPC or USDC address is refused unless
`AGENT_PAYMENTS_MAINNET=1`, which this build never sets.

### Reconciliation

About once a minute the worker matches every payment with its transfer
and its ledger entries, and every transfer from the treasury with a send
made here (`reconcile.ts`). A payment with no transfer, a transfer of
another amount or to another address, a ledger entry missing, or a
transfer nobody here made pauses payments site wide and puts an alert in
the admin queue. The first run starts at the chain's head
(`AGENT_RECONCILE_START_BLOCK` to choose another block). Payments stay
paused until an admin has looked into every open alert and turned them
back on.

### The trust score

`src/lib/trust/score.ts` is a pure function of signals read from what
happened (`signals.ts`); `config.ts` has every weight. Everything starts
at 600; a version or maker with fewer than 10 finished jobs is "new": it
earns nothing yet but loses points. Most factors look back 90 days;
blocks, upheld reports and upheld payment disputes, 30.

| Factor | Points |
|---|---|
| Jobs finished | 4 a point of share above 85% (at least 5 jobs), up to +60, down to -150 |
| Actions the safety check blocked | -15 each, to -120 |
| Reppo's average job score | 2 a point above 70 (at least 3 reviewed), up to +60, down to -80 |
| Jobs Reppo advised against | -20 each, to -100 |
| Reports upheld | -40 each, to -160 |
| Payment disputes upheld | -50 each, to -200 |
| Rent weeks refunded | -30 each, to -120 |
| Freezes | -60 each, to -180; -100 more while one is on |
| Listing on hold now | -40 |
| Age | +1 every 3 days, to +40 |
| Renewals and cancellations | +2 a renewal, to +60; -5 a cancellation, to -60 |
| Payments | +2 each without a problem, to +40; -10 each that failed on chain, to -50 |

Scores are refreshed when a version's jobs finish and once a day, kept
with their factors and a score a day for the trend (`trust.ts`). Board
cards and agent pages show the score, an agent page its top factors, and
the maker's dashboard every factor and the trend for the version and the
maker. Admins see the lowest scores.

### What an agent may pay without asking

The score sets a band (`limits.ts`):

| Band | From | A payment | A day |
|---|---|---|---|
| low | 300 | 0 (always asks) | 0 |
| fair | 500 | 5 USDC | 20 USDC |
| good | 600 | 25 USDC | 100 USDC |
| strong | 700 | 100 USDC | 300 USDC |
| excellent | 780 | 250 USDC | 1000 USDC |
| new | (any) | 5 USDC | 20 USDC |

The renter's auto limit can't go above the band: the stricter of the two
is what it may pay without asking, and the band's day applies on top. A
rule's own limit, the safety check, the phase 0 site limit (SERV's check
asks when the site's day budget is spent) and the site's daily cap on all
agent payments (`AGENT_PAYMENTS_SITE_DAILY_USDC`, 1000) all still apply:
the strictest wins. A frozen agent, maker or renter, an agent stopped
everywhere or a listing on hold can't pay at all, even after a yes. Every
payment question says what the band allows, in the app and on Telegram.
When a score falls a band, renters whose limit it cuts are told.

### Disputes and refunds

A renter disputes an agent payment or a week's rent within
`DISPUTE_WINDOW_DAYS` (14), with a reason and a note: at most 3 open and 6
in 30 days, one per payment or week (`disputes.ts`). Admins uphold or
reject them in the safety queue. An upheld rent dispute is refunded
through the ledger: `refund` to the renter, `earning_reversal` from the
maker (as much of their share as they still have) and `platform_refund`
for the rest. A payment on Base can't be pulled back: an upheld payment
dispute counts against the agent's score instead, and the screen says so
before the renter approves any payment and again before they dispute
one. The three ledger kinds need the owner's `scripts/sql/ledger-kinds.sql`
on a database a deploy only pushed to; until then upheld refunds wait and
the queue says so.

### Screens

- Renter, on an installation's page: the allowance (top up and take
  back), what it may pay without asking and why, payees, receipts with
  their transfer on Basescan, and disputes.
- Maker, on the dashboard: the trust score with every factor and its
  trend.
- Admin: on `/app/admin`, agent payments (the site wide switch, today's
  payments, the treasury against its floor, reconciliation); on
  `/app/admin/safety`, payment alerts and disputes in the queue.
- Routes: `GET`/`POST /api/installations/:id/allowance`, `POST
  /api/installations/:id/payees`, `GET`/`POST /api/disputes`, `POST
  /api/admin/agent-payments`, and `POST /api/admin/moderate` (`uphold`
  or `reject` for a dispute).
- `/demo?safety=spending`, `?safety=queue`, `?safety=approval` and
  `?pay=admin` show them with sample data in development.

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
