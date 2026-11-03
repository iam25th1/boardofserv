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
it runs; a development server gives it back after each cycle, so the deployed
service takes it at its next cycle and keeps it. Each process logs once which
role it has:

```
payments: this process holds the worker lock and runs the payments cycles.
payments: another process holds the worker lock, so this one skips its payments cycles while it does.
```

While the deployed service restarts (a deploy), a running development server
may run a cycle in the gap; the deployed service takes the lock back on its
first cycle. To keep a development server out of payments altogether, set
`BOS_PAYMENTS_WORKER=0` in its `.env.local`.

The database comes from Colima, which does not start by itself after a
reboot. Until `colima start` brings the container back, `/api/health` answers
503 and payments stay off (the boot retries every 30 seconds). To make Colima
start at login: `brew services start colima`.

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
whole set: send every key you keep.

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
`SERV_API_KEY`, `MODEL_FIRST_TOKEN_TIMEOUT_MS`, `CHAT_HISTORY_MESSAGES`,
`CHAT_MAX_TOKENS`, `COMPILE_MAX_TOKENS`, `SKETCH_MAX_TOKENS`,
`HELPER_DAILY_USES`, `BOS_NETWORK` (Base Sepolia), `BOS_MAINNET`,
`BOS_RPC_URL` (Base's public RPC), `BOS_PAYMENTS_WORKER`,
`USDC_TOKEN_ADDRESS`, `USDC_DECIMALS`, `USDC_ENABLED`, `SERV_TOKEN_ADDRESS`,
`SERV_TOKEN_DECIMALS`, `SERV_ENABLED`, `DEPOSIT_CONFIRMATIONS`,
`DEPOSIT_SCAN_INTERVAL_MS`, `DEPOSIT_SCAN_CHUNK`, `DEPOSIT_START_BLOCK`,
`WITHDRAW_MIN_USDC`, `WITHDRAW_MIN_SERV`, `WITHDRAW_AUTO_MAX_USDC`,
`WITHDRAW_AUTO_MAX_SERV`, `WITHDRAW_DAILY_CAP_USDC`, `WITHDRAW_DAILY_CAP_SERV`.

Tests and scripts only, never in the store: `TEST_POSTGRES_URL`,
`CHECK_BUILD`, `RUN_E2E`, `RUN_SERV_DEMO`, `RUN_SKETCH_LIVE`, `LIVE_BUDGET`,
`LIVE_REPORT`, `SMOKE_FROM`, `SMOKE_TIMEOUT_MINUTES`, `SMOKE_WITHDRAW_USDC`.

## Deploy an update

Push the commit to the branch the deploy clone follows (`deploy-pier` until
that pull request is merged; then switch the clone to `main` once with
`git -C ~/.boardofserv/app switch main`). Then:

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
docker exec boardofserv-db pg_dump -U boardofserv -Fc boardofserv \
  > ~/.boardofserv/backups/boardofserv-$(date +%Y%m%d-%H%M).dump
```

Take one before any deploy that changes the schema. The dump holds user
emails, balances, the ledger and encrypted OpenServ keys (useless without
`OPENSERV_KEY_ENC_KEY`), so keep it private and off any synced folder. To
restore into the same database (the service should be stopped:
`pier stop boardofserv`):

```sh
docker exec -i boardofserv-db pg_restore -U boardofserv -d boardofserv --clean --if-exists < ~/.boardofserv/backups/<file>.dump
```

The data itself lives in the Docker volume `boardofserv_boardofserv_pgdata`.

## Still to do by hand

- Allow `https://boardofserv.25th.dev` in the Privy dashboard (allowed
  origins). The login modal loads on the live site, but signing in needs it.
- The database container publishes port 5433 on every interface with the
  default password, so anything on the local network can reach it. Bind it
  to `127.0.0.1` and change the password when the container can be
  recreated.
- `npm ci` warns that Next.js 14.2.15 has a published security advisory;
  move to the patched 14.2 release.
- Cloudflare Web Analytics, which the 25th.dev zone injects, is blocked by
  the content security policy. Turn the injection off for this hostname, or
  allow its two hosts if you want the numbers.
