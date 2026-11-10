#!/usr/bin/env bash
# Backs up the boardofserv database: pg_dump inside the boardofserv-db
# container (through docker exec, so no password is needed or printed), to
# a dated file in ~/boardofserv-backups, keeping the last 14. The owner runs
# it by hand; nothing schedules it. It never stops, starts or restarts
# anything, and never prints a secret.
#
#   scripts/backup-db.sh                 back up now
#   scripts/backup-db.sh --keep 30       keep the last 30 instead
#   scripts/backup-db.sh --dir PATH      somewhere else
#   scripts/backup-db.sh --dry-run       say what it would do, do nothing
#
# Restore steps: docs/DEPLOY-PIER.md, "Back up the database".
set -euo pipefail

DIR="${HOME}/boardofserv-backups"
KEEP=14
CONTAINER="boardofserv-db"
DB="boardofserv"
DB_USER="boardofserv"
DRY=0

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

fail() {
  echo "backup: $1" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || fail "--dir needs a path"
      DIR="$2"
      shift 2
      ;;
    --keep)
      [ $# -ge 2 ] || fail "--keep needs a number"
      KEEP="$2"
      shift 2
      ;;
    --container)
      [ $# -ge 2 ] || fail "--container needs a name"
      CONTAINER="$2"
      shift 2
      ;;
    --dry-run)
      DRY=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1 (see --help)"
      ;;
  esac
done

[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] && [ "$KEEP" -le 365 ] || fail "--keep takes a whole number from 1 to 365"
[[ "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]] || fail "--container takes a container name"
[ -n "$DIR" ] || fail "--dir can't be empty"
case "$DIR" in
  / | /System* | /usr* | /bin* | /sbin* | /etc*) fail "--dir can't be a system folder" ;;
esac

STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="${DIR}/boardofserv-${STAMP}.dump"

if [ "$DRY" -eq 1 ]; then
  echo "backup: would dump database ${DB} from container ${CONTAINER} to ${FILE}"
  echo "backup: would keep the newest ${KEEP} backups in ${DIR}"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "docker isn't on PATH"
docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true || fail "the container ${CONTAINER} isn't running (start Colima and it, then try again; this script starts nothing)"

mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077
PART="${FILE}.part"
trap 'rm -f "$PART"' EXIT

# Custom format: compressed, and pg_restore can restore all or part of it.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB" --format=custom --no-owner >"$PART" || fail "pg_dump failed; nothing was kept"
[ -s "$PART" ] || fail "pg_dump wrote nothing; nothing was kept"
mv "$PART" "$FILE"
trap - EXIT
chmod 600 "$FILE"

SIZE="$(wc -c <"$FILE" | tr -d ' ')"
echo "backup: wrote ${FILE} (${SIZE} bytes)"

# The newest KEEP stay; older ones of ours go. Only files this script names.
COUNT=0
REMOVED=0
while IFS= read -r old; do
  COUNT=$((COUNT + 1))
  if [ "$COUNT" -gt "$KEEP" ]; then
    rm -f -- "$old"
    REMOVED=$((REMOVED + 1))
  fi
done < <(find "$DIR" -maxdepth 1 -type f -name 'boardofserv-[0-9]*-[0-9]*.dump' | sort -r)
echo "backup: keeping the newest ${KEEP}; removed ${REMOVED} older"
