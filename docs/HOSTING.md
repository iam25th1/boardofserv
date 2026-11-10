# Hosting: an honest look

boardofserv runs under Pier on the owner's Mac, public through its own
Cloudflare tunnel (see [DEPLOY-PIER.md](DEPLOY-PIER.md)). That is a good
fit for a beta on test money. This page says plainly where it is fragile,
and what to weigh before real people rely on it or real money moves
through it. Nothing here was changed; it's for deciding later.

## How it runs today

- One Mac runs everything: the Next.js app (Pier service, port 7560), its
  Cloudflare tunnel, the Postgres database (the `boardofserv-db` container
  in Colima), the agents' job worker and the payments worker (inside the
  app's process), and the development servers.
- The deployed app and development share **one database and one
  treasury** (`pier.json`). A development server writes to the same tables
  the live site reads.
- Secrets live in Pier's encrypted store and the development `.env.local`,
  on the same disk.
- Backups: `scripts/backup-db.sh` writes dated dumps to
  `~/boardofserv-backups` on the same Mac, when the owner runs it.

## Where it's fragile

**Power.** A power cut, a drained battery or a restart takes the site, the
workers and the database down together. Colima doesn't start by itself
after a reboot unless `brew services start colima` was set up; until it
does, `/api/health` answers 503 and payments stay off. Scheduled jobs that
fall due while it's down run late, once it's back.

**Sleep.** If the Mac sleeps (lid closed, energy settings, a long idle),
everything stops: no jobs, no Telegram replies, no deposits noticed, and the
tunnel drops, so the site is unreachable. It needs to be set never to sleep
on power (System Settings, Battery or Energy), or kept awake, and a laptop
lid closed without an external display usually means sleep.

**A single machine.** There's no second copy of anything running. A disk
failure, a bad macOS update, a full disk or a mistake on the machine takes
it all down at once, and the backups are on the same disk unless they're
copied off it. Updates to the Mac itself (macOS, Homebrew, Colima, Docker)
can restart or break the stack.

**The network.** The tunnel means no ports are open at home, which is good,
but the site is only as up as the home connection and the router. An
internet outage, a router restart or the ISP changing something takes the
site offline. Cloudflare in front absorbs a lot of noise, but heavy traffic
still lands on one home machine.

**Sharing with development.** One database for development and the live
site means a migration tried in development, a test script pointed at the
wrong place, or a bug in an unfinished branch writes to live data. The
worker lock keeps one payments worker, but agents' jobs and other writes
aren't fenced off. The same goes for the shared treasury.

**Secrets on a daily-use machine.** The treasury's private key and the app's
other secrets are on the same Mac used for everyday work and development.
With test money that's a small risk; with real money it isn't.

## Options to consider later

Roughly in the order they'd help most:

1. **Separate the live database from development.** A second Postgres
   (another container, or a managed one) for the live site only, with
   development on its own. Cheapest, biggest step for safety.
2. **Copy backups off the machine.** The dated dumps to cloud storage or
   another disk, automatically, and a restore tried now and then.
3. **A managed Postgres** (for example Neon, Supabase, Crunchy Bridge or a
   cloud provider's own) with point-in-time recovery, so the database
   survives the Mac.
4. **Move the app off the Mac.** A small always-on server or app platform
   (a VPS from Hetzner or DigitalOcean, or Fly.io or Railway) running the
   same `npm run start:prod`, the same Cloudflare tunnel or a plain HTTPS
   endpoint, with the Mac kept for development. The job and payments
   workers live in the app's process, so a single always-on instance is
   enough; two instances need the worker lock to keep one payments worker.
5. **Keep the treasury key away from everyday machines.** On a server you
   only reach for deploys, or in a key management service, before any real
   money.
6. **Watch it from outside.** An uptime check on `/api/health` that alerts
   the owner by Telegram or email when it fails.

What staying on the Mac needs, if it does for a while: never sleep on
power, start Colima at login, a UPS if outages are common, backups copied
off the machine, and a separate live database.
