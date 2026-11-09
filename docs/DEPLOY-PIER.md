# boardofserv on Pier

boardofserv runs on this Mac under [Pier](https://github.com/iam25th1/pier) and
is public at **https://boardofserv.25th.dev**, through a Cloudflare tunnel of
its own. This is the runbook: what runs where, the environment, and how to
deploy, read logs, roll back and back up.

## What runs

| | |
|---|---|
| Pier service | `boardofserv` (`<redacted>`), runtime `node`, autostart on |
| Port | `127.0.0.1:7560`, never published on the LAN |
| Directory | `~/.boardofserv/app`, a clone of `iam25th1/boardofserv` used only for this. Never the development checkout: a build there would overwrite the `.next` a running `npm run dev` uses. |
| Start | `npm run start:prod` (`next start --hostname 127.0.0.1 --port 7560`) |
| Health | `GET /api/health`, which Pier checks; `{"ok":true,"database":"up","network":"Base Sepolia","payments":"on"}`, or a 503 while the database is down |
| Manifest | `pier.json` in the repository |
| Tunnel service | `boardofserv-tunnel` (`<redacted>`), runtime `worker`, autostart on, in `~/.boardofserv/tunnel` |

`/demo` and the `?sketch=` fixtures don't exist in this build (they are
development only), and every response carries the security headers from
`next.config.mjs`.

## The tunnel

boardofserv has its own Cloudflare tunnel, run as its own process, like
servpit's. It is not part of any Pier tunnel record and no other tunnel reads
its config.

| | |
|---|---|
| Cloudflare tunnel | `boardofserv`, id `<redacted>` |
| Account | the one that holds 25th.dev (account `<redacted>...`) |
| DNS | `boardofserv.25th.dev` CNAME `<redacted>.cfargotunnel.com`, proxied |
| Config | `~/.boardofserv/tunnel/config.yml` (reference copy: `deploy/cloudflared.yml`) |
| Credentials | `~/.boardofserv/tunnel/boardofserv-credentials.json`, mode 0400. Secret: never print or commit it. |
| Cert for management calls | `~/.cloudflared/cert.pem` (zone 25th.dev, `<redacted>...`) |
| Process | `/opt/homebrew/bin/cloudflared tunnel --config ~/.boardofserv/tunnel/config.yml --no-autoupdate run`, supervised by Pier |

The tunnel runs by id with its credentials file, so it never reads a cert.
Only management calls (`tunnel create`, `route dns`, `tunnel info`) need the
cert, and they always name it:

```sh
cloudflared tunnel --origincert ~/.cloudflared/cert.pem info boardofserv
```

Never run a bare `cloudflared tunnel login`: it writes `~/.cloudflared/cert.pem`,
which belongs to another account. The ingress sends `boardofserv.25th.dev`
straight to `127.0.0.1:7560`, not through Pier's proxy, and everything else to
a 404. To change it, edit both copies of the config, check it with
`cloudflared tunnel --config ~/.boardofserv/tunnel/config.yml ingress validate`,
and restart `boardofserv-tunnel` from the Pier dashboard.

## Shared with development: database, treasury and the worker lock

The deployed service uses the same database as `npm run dev` (the
`boardofserv-db` container, Postgres 16 on port 5433) and the same treasury.
Everything written on one shows on the other.

Only one process ever runs the payments worker (deposit scan, hold sweep,
payouts): it needs a Postgres advisory lock, held on a connection of its own
(`src/lib/payments/workerLock.ts`). A production server keeps the lock while
it runs; a development server gives it back after each cycle. The deployed
service, when it finds the lock taken, tries again after 3 seconds rather
than waiting a whole 30 second interval, so it takes the lock in the gap after
a development cycle and keeps it. (Without that, two servers ticking in step
left the deployed one skipping every time while the development server ran
the cycles.) Each process logs once which role it has:

```
payments: this process holds the worker lock and runs the payments cycles.
payments: another process holds the worker lock, so this one skips its payments cycles while it does.
```

While the deployed service restarts (a deploy), a running development server
may run a cycle in the gap; the deployed service takes the lock back within
seconds. To keep a development server out of payments altogether, set
`BOS_PAYMENTS_WORKER=0` in its `.env.local`.

The database comes from Colima, which does not start by itself after a
reboot. Until `colima start` brings the container back, `/api/health` answers
503 and payments stay off (the boot retries every 30 seconds). To make Colima
start at login: `brew services start colima` (see
[Lock down the database](#lock-down-the-database)).

## Environment

The service's environment lives in Pier's encrypted store
(`~/.pier/env/<redacted>.enc`), copied from the development
`.env.local` without printing any value. Pier injects it when the service
starts and during deploys, so `next build` sees `NEXT_PUBLIC_PRIVY_APP_ID`.
The deploy checkout has no `.env.local`. Pier has no command to set a value:
change one in the dashboard (http://127.0.0.1:7433, the service's
Environment tab), which shows names and a masked preview but never a whole
value, then restart the service (or deploy, for a `NEXT_PUBLIC_` value, which
is built in). Through Pier's API, a `PUT` of the environment replaces the
whole set: send every key you keep. A key sent with the value
`__PIER_KEEP__` keeps the value Pier already has, so one value can change
without the others ever leaving Pier; that is how `scripts/db-lockdown.sh`
changes `DATABASE_URL` alone (`scripts/db-lockdown-env.mjs`, `pier-set`).

In the store (14):

- `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID`
- `OPENSERV_KEY_ENC_KEY`, `OPENSERV_API_URL`, `OPENSERV_RUNTIME_URL`
- `DATABASE_URL`
- `FALLBACK_BASE_URL`, `FALLBACK_API_KEY`, `FALLBACK_MODEL`, `FALLBACK_LABEL`
- `TREASURY_ADDRESS`, `TREASURY_PRIVATE_KEY`
- `ADMIN_USER_IDS`

Set by Pier: `NODE_ENV=production`, `PORT=7560`, `HOST` and `HOSTNAME`
(`127.0.0.1`), `PIER_PROJECT=boardofserv`, plus `PATH`, `HOME`, `USER`, `LANG`,
`TMPDIR` and `TERM`. Deploy steps also get `CI=1`.

Read by the app, not set, so their defaults apply (see `.env.example`):
`SERV_API_KEY`, `DOLPHIN_API_KEY`, `DOLPHIN_BASE_URL`, `DOLPHIN_MODEL`,
`CHAT_DAILY_LIMIT` (30), `DAILY_SPEND_LIMIT_USD` (5), `INVITE_ONLY` (on),
`SERV_PRICE_INPUT_PER_M`, `SERV_PRICE_OUTPUT_PER_M`,
`DOLPHIN_PRICE_INPUT_PER_M`, `DOLPHIN_PRICE_OUTPUT_PER_M`,
`FALLBACK_PRICE_INPUT_PER_M`, `FALLBACK_PRICE_OUTPUT_PER_M`,
`MODEL_FIRST_TOKEN_TIMEOUT_MS`, `CHAT_HISTORY_MESSAGES`,
`CHAT_MAX_TOKENS`, `COMPILE_MAX_TOKENS`, `SKETCH_MAX_TOKENS` (320),
`AGENT_PLAN_MAX_TOKENS` (3500), `AGENT_PLAN_TIMEOUT_MS` (120000),
`DOLPHIN_CODE_TIMEOUT_MS` (240000),
`HELPER_DAILY_USES`, `BOS_NETWORK` (Base Sepolia), `BOS_MAINNET`,
`BOS_RPC_URL` (Base's public RPC), `BOS_PAYMENTS_WORKER`,
`USDC_TOKEN_ADDRESS`, `USDC_DECIMALS`, `USDC_ENABLED`, `SERV_TOKEN_ADDRESS`,
`SERV_TOKEN_DECIMALS`, `SERV_ENABLED`, `DEPOSIT_CONFIRMATIONS`,
`DEPOSIT_SCAN_INTERVAL_MS`, `DEPOSIT_SCAN_CHUNK`, `DEPOSIT_START_BLOCK`,
`WITHDRAW_MIN_USDC`, `WITHDRAW_MIN_SERV`, `WITHDRAW_AUTO_MAX_USDC`,
`WITHDRAW_AUTO_MAX_SERV`, `WITHDRAW_DAILY_CAP_USDC`, `WITHDRAW_DAILY_CAP_SERV`.

Connections (Telegram, Google Sheets, web search), to add to the store
before the deploy that brings them: `TELEGRAM_BOT_TOKEN`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `BRAVE_SEARCH_API_KEY`. Optional, with defaults:
`APP_URL` (https://boardofserv.25th.dev), `AGENT_SHEET_CALLS_PER_DAY` (500),
`AGENT_SEARCHES_PER_DAY` (50), `SITE_SEARCHES_PER_DAY` (1000). Never in the
store: `TELEGRAM_DEV_WEBHOOK_SECRET` (development only, ignored in
production). The webhook's own secret isn't an environment value: it lives
as a hash in the database (`telegram_webhook`), set by the webhook script.

Tests and scripts only, never in the store: `TEST_POSTGRES_URL`,
`CHECK_BUILD`, `RUN_E2E`, `RUN_SERV_DEMO`, `RUN_SKETCH_LIVE`, `LIVE_BUDGET`,
`LIVE_REPORT`, `SMOKE_FROM`, `SMOKE_TIMEOUT_MINUTES`, `SMOKE_WITHDRAW_USDC`.

## Deploy an update

Merge to `main`, which the deploy clone follows. Then:

```sh
pier deploy boardofserv
```

Pier runs, in `~/.boardofserv/app`:

1. `git pull --ff-only`
2. `npm ci --ignore-scripts --include=dev`. Pier's deploy environment sets
   `NODE_ENV=production`, under which a plain `npm ci` leaves out the
   devDependencies the build needs (TypeScript, ESLint, drizzle-kit). That is
   what broke servpit's deploy.
3. `npm run build`
4. `npm run db:push:deploy`: the schema onto the existing database. An
   additive change is applied. A change drizzle-kit would ask about (data
   loss, or a rename) fails the deploy instead of being skipped quietly: make
   it by hand first (a SQL file under `src/lib/db/migrations`, applied with
   `docker exec -i boardofserv-db psql -U boardofserv boardofserv < file.sql`),
   then deploy again.

then restarts the service. Check it:

```sh
curl -s https://boardofserv.25th.dev/api/health
```

The build replaces `.next` under the running server, so pages can fail for
the minute a deploy takes. If a deploy fails after the build (step 4), the
old process is still running on files it didn't build: fix the cause and
deploy again, or `pier restart boardofserv`.

### After the deploy that brings connections

1. In Google Cloud, the OAuth client (type Web application) has
   `https://boardofserv.25th.dev/api/connections/google/callback` as an
   authorized redirect URI. While the consent screen is in Testing, add each
   owner who will connect Google as a test user (100 at most); their access
   lasts 7 days, after which their installations pause and say so.
2. `pier deploy boardofserv` (the schema push adds the new tables and
   columns, and widens the installation status check to take `testing`).
3. Point the bot's webhook at the site, with a fresh secret, from the deploy
   folder with the production environment (the shared database and the same
   bot token are in the development `.env.local`):

   ```sh
   cd ~/.boardofserv/app
   npx vite-node --config vitest.config.ts scripts/telegram-webhook.ts -- --env-file ~/boardofserv/.env.local --apply
   ```

   It prints Telegram's answer and the webhook's address, never the
   secret. Without `--apply` it only shows the webhook as it is.
4. Set `BOS_AGENT_WORKER` back on (remove it, or set it to anything but 0)
   in the dashboard, then restart the service.

## Logs

```sh
pier logs boardofserv 200
pier logs boardofserv-tunnel 100
grep "worker lock" ~/.pier/logs/<redacted>.log
```

The files are `~/.pier/logs/<redacted>.log` (service) and
`~/.pier/logs/<redacted>.log` (tunnel), rotated at 5 MB with three
kept. Pier scrubs secret values out of them. The dashboard tails both live.
Every `pier` command signs in a fresh session and Pier keeps the last ten, so
a long run of them signs the dashboard out.

## Roll back

The clean way is a revert: `git revert <bad commit>` on the branch, push,
`pier deploy boardofserv`.

When it can't wait, deploy an older commit from a branch of its own:

```sh
git -C ~/boardofserv push origin <good commit>:refs/heads/rollback
git -C ~/.boardofserv/app fetch origin
git -C ~/.boardofserv/app switch -C rollback --track origin/rollback
pier deploy boardofserv
```

Then fix forward and return the clone to its branch
(`git -C ~/.boardofserv/app switch main`, deploy, and delete the `rollback`
branch). A rollback across a schema change fails at `db:push:deploy`,
because the older schema would drop the newer columns. Leave the database as
it is, since older code ignores columns it doesn't know, and start the rolled
back build with `pier restart boardofserv`.

## Back up the database

```sh
mkdir -p ~/.boardofserv/backups && chmod 700 ~/.boardofserv/backups
(umask 077; docker exec boardofserv-db pg_dump -U boardofserv -Fc boardofserv \
  > ~/.boardofserv/backups/boardofserv-$(date +%Y%m%d-%H%M).dump)
```

Take one before any deploy that changes the schema. The dump holds user
emails, balances, the ledger and encrypted OpenServ keys (useless without
`OPENSERV_KEY_ENC_KEY`), so keep it private and off any synced folder. To
restore into the same database (the service should be stopped:
`pier stop boardofserv`):

```sh
docker exec -i boardofserv-db pg_restore -U boardofserv -d boardofserv --clean --if-exists < ~/.boardofserv/backups/<file>.dump
```

These commands use the container's own socket, so they work with or without
the password. The data itself lives in the Docker volume
`boardofserv_boardofserv_pgdata`.

## Lock down the database

`boardofserv-db` was created by `npm run db:up` publishing port 5433 on every
interface (Colima forwards it as `*:5433`) with the default password from
`docker-compose.yml`, so anything on the local network can reach the database
that holds the balances. `scripts/db-lockdown.sh` closes both. Nobody runs it
but the owner.

```sh
cd ~/boardofserv
bash scripts/db-lockdown.sh            # dry run: prints every step, changes nothing
bash scripts/db-lockdown.sh --apply    # asks you to type LOCK DOWN, then does them
```

With `--apply`, in order: a full `pg_dump` into `~/.boardofserv/backups/`
(stopping if it fails or is empty) and a row count of every table; a new 64
character random password on the database role, never printed or logged; the
container recreated from the same image and the same named volume, published
on `127.0.0.1:5433` only (the old one is kept, stopped, as
`boardofserv-db-pre-lockdown`); the row counts compared and the new password
tried from inside the container and from the Mac; then the new
`DATABASE_URL` written into `.env.local` (that line only) and into the
`boardofserv` service in Pier (that value only). It never redeploys the
service or starts the dev server.

**When.** Any time a short outage is fine, once the change that added the
script is merged, deployed (`pier deploy boardofserv`) and pulled into
`~/boardofserv`. Stop the dev server first: it would keep the old password
until it starts again. (After that pull, `npm ci --ignore-scripts` in
`~/boardofserv` brings its `node_modules` up to the new Next.js before
`npm run dev`.)

**Downtime.** The site answers 503 from the moment the container stops
(step 4) until the redeploy finishes: the script itself takes under a minute,
the redeploy a few more.

**Afterwards**, as the script prints:

```sh
pier deploy boardofserv                         # starts with the new DATABASE_URL
curl -s https://boardofserv.25th.dev/api/health # {"ok":true,...}
npm run dev                                     # the dev server, again
docker rm boardofserv-db-pre-lockdown           # once both work; the volume stays
```

**Rolling back.** If a step fails the script stops and prints the way back
from the step it reached: the backup path, the old container's settings
(also saved next to the backup as `<database>-<time>.container.txt`), and the
commands. In short, while `.env.local` still has the old `DATABASE_URL`:

```sh
docker rm -f boardofserv-db                                    # the new container, if there is one
docker rename boardofserv-db-pre-lockdown boardofserv-db
docker start boardofserv-db
until docker exec boardofserv-db pg_isready -q; do sleep 1; done
node scripts/db-lockdown-env.mjs password-sql .env.local \
  | docker exec -i boardofserv-db psql -X -q -v ON_ERROR_STOP=1 -U boardofserv -d boardofserv >/dev/null 2>&1 \
  && echo "old password back"
```

The last command reads the old password from `.env.local` and pipes it
straight into `psql`; it refuses to print it to a terminal. Restore the
backup (above) only if rows are missing. The backup is never deleted. If only
the Pier step failed, `.env.local` already has the new `DATABASE_URL`: copy it
into Pier (dashboard, Environment) or run
`node scripts/db-lockdown-env.mjs pier-set .env.local`, then redeploy.

**After a reboot.** The new container keeps `--restart unless-stopped`, but
Docker only runs once Colima does, and Colima does not start at login today.
To make the database come back by itself, the owner runs once:

```sh
brew services start colima
```

The script was rehearsed end to end on a scratch container, a scratch env file
and a stand-in for Pier's API; the real container has not been through it.

## Still to do by hand

- Sign in once on the live site. Privy's iframe already names
  `https://boardofserv.25th.dev` as an allowed parent, so the origin looks
  allowed in the Privy dashboard, but a sign-in has not been tried.
- Run `scripts/db-lockdown.sh --apply` ([above](#lock-down-the-database)),
  then `brew services start colima`.
