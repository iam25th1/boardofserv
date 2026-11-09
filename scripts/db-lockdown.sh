#!/usr/bin/env bash
# Locks down the database container, boardofserv-db: a backup, a new random
# password on the database role, and the container recreated from the same
# image and the same named volume but published on 127.0.0.1 only (it was
# created publishing port 5433 on every interface with the default password).
#
#   bash scripts/db-lockdown.sh           dry run: prints every step, changes nothing
#   bash scripts/db-lockdown.sh --apply   takes the steps, once you type LOCK DOWN
#
# It changes only the database container, the backup folder, .env.local's
# DATABASE_URL line and the boardofserv Pier service's DATABASE_URL. It never
# redeploys or restarts a Pier service and never starts the dev server; it
# tells you to. The new password is never printed, logged or put on a command
# line. docs/DEPLOY-PIER.md, "Lock down the database", says when to run it and
# how to roll back.
#
# Written for the bash macOS ships (3.2).
set -Eeuo pipefail
set -o noclobber
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/scripts/db-lockdown-env.mjs"

# The BOS_* overrides exist to rehearse on a scratch container. Leave them unset.
CONTAINER="${BOS_DB_CONTAINER:-boardofserv-db}"
PORT="${BOS_DB_PORT:-5433}"
ENV_FILE="${BOS_ENV_FILE:-$ROOT/.env.local}"
BACKUP_DIR="${BOS_BACKUP_DIR:-$HOME/.boardofserv/backups}"
SERVICE="${BOS_PIER_SERVICE:-boardofserv}"
OLD="$CONTAINER-pre-lockdown"
DATA=/var/lib/postgresql/data
STAMP="$(date +%Y%m%d-%H%M%S)"

usage() {
  printf 'usage: bash scripts/db-lockdown.sh [--apply]\n'
  printf '  no flag   dry run: print every step, change nothing\n'
  printf '  --apply   take the steps, after you type LOCK DOWN\n'
}

plan() {
  cat <<EOF
Before you run it with --apply:
  - Pick a time when a short outage is fine. boardofserv.25th.dev answers 503
    from step 4 until you redeploy it in Pier: a few minutes in all, most of
    them the redeploy.
  - Stop the dev server (Ctrl-C where npm run dev runs). It would keep the old
    password until it starts again.

Steps, in order:
  1. Ask you to type LOCK DOWN. Anything else stops here, with nothing changed.
  2. Check, changing nothing, then back up.
     Checks: $CONTAINER is running from one named volume and publishes
     port 5432 on $PORT; DATABASE_URL in the env file below names the same
     role, port and database; Pier's $SERVICE service has that same
     DATABASE_URL.
     Backup: docker exec $CONTAINER pg_dump -Fc, into
       $BACKUP_DIR/<database>-<date>-<time>.dump
     (folder 0700, file 0600). It stops if pg_dump fails, the file is empty
     or pg_restore cannot list it. Then it counts the rows of every table.
  3. Generate a 64 character random password (openssl rand -hex 32) and set
     it with ALTER ROLE ... PASSWORD, sent to psql on stdin with statement
     logging off for that session. It is never printed, logged or put on a
     command line. Until step 6 is done it is also kept, owner only, in
       $BACKUP_DIR/<database>-<date>-<time>.database-url
     so it can't be lost.
  4. Recreate the container: stop $CONTAINER, rename it
     $OLD (kept, stopped), and start a new $CONTAINER
     from the same image and the same named volume, with the same restart
     policy, published on 127.0.0.1:$PORT only.
  5. Check it: wait for Postgres, count the rows again and compare them with
     step 2, sign in with the new password inside the container and from this
     Mac on 127.0.0.1:$PORT, and confirm 127.0.0.1:$PORT is its only
     published port.
  6. Write the new DATABASE_URL into the env file (that line only)
       $ENV_FILE
     and into the $SERVICE Pier service's env (that value only, through
     Pier's API; the other values never leave Pier).
  7. Print what is left for you: redeploy $SERVICE in Pier and start the dev
     server again. It does neither itself.

If a step fails it stops and prints how to roll back: the backup path and the
old container's settings. It never deletes the backup.
EOF
}

case "$#:${1:-}" in
  0:) MODE=dry ;;
  1:--apply) MODE=apply ;;
  1:-h | 1:--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [ "$MODE" = dry ]; then
  printf 'Database lockdown for %s: dry run. Nothing is changed.\n' "$CONTAINER"
  printf 'Run bash scripts/db-lockdown.sh --apply to take these steps.\n\n'
  plan
  exit 0
fi

# ---------------------------------------------------------------------------
# --apply

STAGE=none # how far it got, for the roll back advice
BACKUP=""
NEW_URL_FILE=""
NEW_PW=""
SETTINGS=""
DB_USER=postgres
DB_NAME=postgres

step() { printf '\n[%s/7] %s\n' "$1" "$2"; }
say() { printf '  %s\n' "$*"; }

old_settings() {
  printf 'image    %s (%s)\n' "$IMAGE" "$IMAGE_ID"
  printf 'volume   %s at %s\n' "$VOLUME" "$DATA"
  printf 'port     5432/tcp published on %s\n' "$OLD_BINDING"
  printf 'restart  %s\n' "$RESTART"
  printf 'network  %s\n' "$NETWORK"
  printf 'env      %s(values not shown)\n' "$USER_ENV"
}

rollback_help() {
  local psql_in="docker exec -i $CONTAINER psql -X -q -v ON_ERROR_STOP=1 -U $DB_USER -d $DB_NAME"
  printf '\nHow to roll back\n'
  if [ -n "$BACKUP" ] && [ -e "$BACKUP" ]; then
    printf '  Backup (kept, never deleted): %s\n' "$BACKUP"
  fi
  case "$STAGE" in
    none | checks | backup)
      printf '  Nothing in the database, the container, %s or Pier was changed.\n' "$ENV_FILE"
      return
      ;;
    pier)
      printf '  The database is locked down and %s has the new DATABASE_URL.\n' "$ENV_FILE"
      printf '  Only Pier still has the old one. Finish by hand: set DATABASE_URL for %s\n' "$SERVICE"
      printf '  in the Pier dashboard (http://127.0.0.1:7433, Environment) to the value in\n'
      printf '  %s, or run:\n' "$ENV_FILE"
      printf '    node %s pier-set %s\n' "$HELPER" "$ENV_FILE"
      printf '  Then redeploy %s in Pier and start the dev server again.\n' "$SERVICE"
      return
      ;;
  esac
  printf '  The database role may have the new password; %s and Pier still have the old one.\n' "$ENV_FILE"
  if [ -n "$SETTINGS" ]; then
    printf '  The old container, %s, with these settings (also in %s):\n' "$CONTAINER" "$SETTINGS"
    old_settings | sed 's/^/    /'
  fi
  local n=1
  if [ "$STAGE" != password ]; then
    printf '  %s. Put the old container back:\n' "$n"
    if [ "$STAGE" = recreated ]; then
      printf '       docker rm -f %s\n' "$CONTAINER"
    fi
    if [ "$STAGE" != stopped ]; then
      printf '       docker rename %s %s\n' "$OLD" "$CONTAINER"
    fi
    printf '       docker start %s\n' "$CONTAINER"
    printf '       until docker exec %s pg_isready -q; do sleep 1; done\n' "$CONTAINER"
    n=$((n + 1))
  fi
  printf '  %s. Put the old password back. It is read from %s and never printed:\n' "$n" "$ENV_FILE"
  printf '       node %s password-sql %s | %s >/dev/null 2>&1 && echo "old password back"\n' "$HELPER" "$ENV_FILE" "$psql_in"
  n=$((n + 1))
  printf '  %s. Only if rows are missing, restore the backup:\n' "$n"
  printf '       docker exec -i %s pg_restore -U %s -d %s --clean --if-exists < %s\n' "$CONTAINER" "$DB_USER" "$DB_NAME" "${BACKUP:-<backup>}"
  if [ -n "$NEW_URL_FILE" ] && [ -e "$NEW_URL_FILE" ]; then
    printf '  Or finish by hand instead: the new DATABASE_URL is in %s (owner only).\n' "$NEW_URL_FILE"
  fi
}

die() {
  trap - ERR INT TERM
  printf '\nStopped: %s\n' "$*" >&2
  rollback_help
  exit 1
}

trap 'die "unexpected failure on line $LINENO"' ERR
trap 'die "interrupted"' INT TERM

inspect() { docker inspect -f "$2" "$1"; }

# The value of one non-secret env setting of the container. Never called for
# POSTGRES_PASSWORD.
env_value() {
  inspect "$CONTAINER" "{{range .Config.Env}}{{if eq (index (split . \"=\") 0) \"$1\"}}{{index (split . \"=\") 1}}{{end}}{{end}}"
}

bindings() {
  inspect "$1" '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{$p}} {{.HostIp}} {{.HostPort}};{{end}}{{end}}'
}

count_rows() {
  docker exec -i "$CONTAINER" psql -X -q -A -t -F ' ' -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <<'SQL'
select format('%I.%I', table_schema, table_name),
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables
where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
order by 1;
SQL
}

printf 'Database lockdown for %s.\n\n' "$CONTAINER"
plan

step 1 "Confirm"
printf '  Type LOCK DOWN to go on: '
answer=""
IFS= read -r answer || true
if [ "$answer" != "LOCK DOWN" ]; then
  printf '\n  Not confirmed. Nothing was changed.\n'
  exit 1
fi

step 2 "Check, then back up"
STAGE=checks
for tool in docker node openssl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done
[ -f "$ENV_FILE" ] || die "there is no $ENV_FILE"
RUNNING="$(inspect "$CONTAINER" '{{.State.Running}}' 2>/dev/null)" || die "there is no container named $CONTAINER"
[ "$RUNNING" = true ] || die "$CONTAINER is not running. Start it (docker start $CONTAINER) and run this again."
if docker inspect "$OLD" >/dev/null 2>&1; then
  die "a container named $OLD already exists, from an earlier run. Remove it once you no longer need it (docker rm $OLD), then run this again."
fi

IMAGE="$(inspect "$CONTAINER" '{{.Config.Image}}')"
IMAGE_ID="$(inspect "$CONTAINER" '{{.Image}}')"
RESTART="$(inspect "$CONTAINER" '{{.HostConfig.RestartPolicy.Name}}')"
NETWORK="$(inspect "$CONTAINER" '{{.HostConfig.NetworkMode}}')"
[ -n "$RESTART" ] || RESTART=no

MOUNTS="$(inspect "$CONTAINER" '{{range .Mounts}}{{.Type}} {{.Name}} {{.Destination}};{{end}}')"
case "$MOUNTS" in
  "volume "*" $DATA;") VOLUME="${MOUNTS#volume }" && VOLUME="${VOLUME% "$DATA;"}" ;;
  *) die "expected one named volume at $DATA on $CONTAINER, found: ${MOUNTS:-none}" ;;
esac
case "$VOLUME" in
  "" | *[!A-Za-z0-9_.-]*) die "expected one named volume at $DATA on $CONTAINER, found: $MOUNTS" ;;
esac

OLD_PORTS="$(bindings "$CONTAINER")"
case "$OLD_PORTS" in
  "5432/tcp "*" $PORT;") ;;
  *) die "expected $CONTAINER to publish 5432/tcp on port $PORT, found: ${OLD_PORTS:-nothing}" ;;
esac
[ "$(printf '%s' "$OLD_PORTS" | tr -cd ';')" = ";" ] || die "expected one published port on $CONTAINER, found: $OLD_PORTS"
OLD_IP="${OLD_PORTS#5432/tcp }"
OLD_IP="${OLD_IP% "$PORT;"}"
case "$OLD_IP" in
  "" | 0.0.0.0) OLD_BINDING="0.0.0.0:$PORT (every interface)" ;;
  *) OLD_BINDING="$OLD_IP:$PORT" ;;
esac

# Settings beyond the image's own: only these three are expected, and only
# the role and database names are read. The old password is never read.
IMAGE_ENV=" $(docker image inspect -f '{{range .Config.Env}}{{index (split . "=") 0}} {{end}}' "$IMAGE_ID") "
USER_ENV=""
for name in $(inspect "$CONTAINER" '{{range .Config.Env}}{{index (split . "=") 0}} {{end}}'); do
  case "$IMAGE_ENV" in *" $name "*) continue ;; esac
  case "$name" in
    POSTGRES_USER | POSTGRES_PASSWORD | POSTGRES_DB) USER_ENV="$USER_ENV$name " ;;
    *) die "$CONTAINER has a setting this script does not carry over: $name" ;;
  esac
done
DB_USER="$(env_value POSTGRES_USER)"
DB_USER="${DB_USER:-postgres}"
DB_NAME="$(env_value POSTGRES_DB)"
DB_NAME="${DB_NAME:-$DB_USER}"

IMAGE_REF="$IMAGE"
[ "$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)" = "$IMAGE_ID" ] || IMAGE_REF="$IMAGE_ID"

DESCRIBED="$(node "$HELPER" describe "$ENV_FILE")" || die "cannot read DATABASE_URL in $ENV_FILE"
read -r URL_USER URL_HOST URL_PORT URL_DB <<<"$DESCRIBED"
[ "$URL_USER" = "$DB_USER" ] && [ "$URL_DB" = "$DB_NAME" ] && [ "$URL_PORT" = "$PORT" ] ||
  die "DATABASE_URL in $ENV_FILE ($URL_USER@$URL_HOST:$URL_PORT/$URL_DB) is not $CONTAINER ($DB_USER@localhost:$PORT/$DB_NAME)"
case "$URL_HOST" in
  localhost | 127.0.0.1) ;;
  *) die "DATABASE_URL in $ENV_FILE points at $URL_HOST, not this Mac" ;;
esac
node "$HELPER" pier-check "$ENV_FILE" | sed 's/^/  /' || die "Pier's DATABASE_URL for $SERVICE could not be checked"

say "container $CONTAINER:"
SETTINGS_TEXT="$(old_settings)"
printf '%s\n' "$SETTINGS_TEXT" | sed 's/^/    /'

STAGE=backup
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
SETTINGS="$BACKUP_DIR/$DB_NAME-$STAMP.container.txt"
printf '%s\n' "$CONTAINER, before the lockdown" "$SETTINGS_TEXT" >"$SETTINGS"
BACKUP="$BACKUP_DIR/$DB_NAME-$STAMP.dump"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc >"$BACKUP" || die "pg_dump failed"
chmod 600 "$BACKUP"
[ -s "$BACKUP" ] || die "the dump is empty"
ENTRIES="$(docker exec -i "$CONTAINER" pg_restore --list <"$BACKUP" | grep -c '^[0-9]')" || die "pg_restore cannot read the dump"
say "backup: $BACKUP ($(wc -c <"$BACKUP" | tr -d ' ') bytes, $ENTRIES entries)"

ROWS_BEFORE="$BACKUP_DIR/$DB_NAME-$STAMP.rows-before.txt"
count_rows >"$ROWS_BEFORE" || die "could not count the rows"
[ -s "$ROWS_BEFORE" ] || die "$DB_NAME has no tables"
say "rows:"
sed 's/^/    /' "$ROWS_BEFORE"

step 3 "New password"
NEW_PW="$(openssl rand -hex 32)" || die "openssl could not make a password"
[ "${#NEW_PW}" -eq 64 ] || die "openssl gave an unexpected password"
NEW_URL_FILE="$BACKUP_DIR/$DB_NAME-$STAMP.database-url"
printf '%s' "$NEW_PW" | node "$HELPER" write-new-url "$ENV_FILE" "$NEW_URL_FILE" | sed 's/^/  /' || die "could not keep the new DATABASE_URL"
STAGE=password
node "$HELPER" password-sql "$NEW_URL_FILE" |
  docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 ||
  die "ALTER ROLE failed (psql's output is hidden, since it can quote the statement)"
say "set on role $DB_USER (not shown)"

step 4 "Recreate the container on 127.0.0.1:$PORT"
docker stop -t 30 "$CONTAINER" >/dev/null || die "docker stop $CONTAINER failed"
STAGE=stopped
docker rename "$CONTAINER" "$OLD" || die "docker rename failed"
STAGE=renamed
say "old container stopped and kept as $OLD"
# The values reach docker run through its environment, never its arguments.
POSTGRES_USER="$DB_USER" POSTGRES_DB="$DB_NAME" POSTGRES_PASSWORD="$NEW_PW" \
  docker run -d --name "$CONTAINER" --restart "$RESTART" \
  -e POSTGRES_USER -e POSTGRES_DB -e POSTGRES_PASSWORD \
  -p "127.0.0.1:$PORT:5432" \
  -v "$VOLUME:$DATA" \
  "$IMAGE_REF" >/dev/null || die "docker run failed"
STAGE=recreated
say "new $CONTAINER from $IMAGE_REF with volume $VOLUME"

step 5 "Check"
tries=0
until docker exec "$CONTAINER" pg_isready -q -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || die "Postgres did not come up within a minute"
  sleep 1
done
[ "$(bindings "$CONTAINER")" = "5432/tcp 127.0.0.1 $PORT;" ] || die "the new container is not published on 127.0.0.1:$PORT only"
say "published on 127.0.0.1:$PORT only"
ROWS_AFTER="$BACKUP_DIR/$DB_NAME-$STAMP.rows-after.txt"
count_rows >"$ROWS_AFTER" || die "could not count the rows"
if ! cmp -s "$ROWS_BEFORE" "$ROWS_AFTER"; then
  diff "$ROWS_BEFORE" "$ROWS_AFTER" | sed 's/^/    /' || true
  say "More rows after can be writes that landed between the two counts, from"
  say "an app still running; fewer rows means data is missing."
  die "the row counts differ from step 2 (before: <, after: >)"
fi
say "row counts match step 2 ($(wc -l <"$ROWS_AFTER" | tr -d ' ') tables)"
SIGNED_IN="$(PGPASSWORD="$NEW_PW" docker exec -e PGPASSWORD "$CONTAINER" psql -X -q -A -t -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -c 'select 1' 2>/dev/null)" || true
[ "$SIGNED_IN" = 1 ] || die "the new password does not sign in inside the container"
say "new password signs in inside the container"
tries=0
until node "$HELPER" check-url "$NEW_URL_FILE" >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 20 ] || die "the new DATABASE_URL does not sign in from this Mac: $(node "$HELPER" check-url "$NEW_URL_FILE" 2>&1 || true)"
  sleep 1
done
say "new DATABASE_URL signs in from this Mac"

step 6 "Write the new DATABASE_URL"
node "$HELPER" set-env-file "$ENV_FILE" "$NEW_URL_FILE" | sed 's/^/  /' || die "could not write $ENV_FILE"
STAGE=pier
node "$HELPER" pier-set "$NEW_URL_FILE" | sed 's/^/  /' || die "could not change DATABASE_URL in Pier"
STAGE=done
rm -f "$NEW_URL_FILE"
NEW_URL_FILE=""
NEW_PW=""

step 7 "Left for you"
cat <<EOF
  The database is locked down. In this order:
  1. Redeploy $SERVICE in Pier, so it starts with the new DATABASE_URL:
       pier deploy $SERVICE
     then check: curl -s https://boardofserv.25th.dev/api/health
  2. Start the dev server again: npm run dev
  3. Once both work, remove the old container. Its data is in the volume
     $VOLUME, which stays:
       docker rm $OLD
  Backup: $BACKUP
  Keep it private and off any synced folder; it holds user emails and balances.
EOF
