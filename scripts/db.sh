#!/bin/sh
# Starts or stops the local Postgres: sh scripts/db.sh up|down
#
# Uses docker compose (docker-compose.yml) when the plugin is installed.
# Without it, plain docker runs the same database: same image, credentials,
# port 5433 (on 127.0.0.1 only) and data volume, in a container named
# boardofserv-db. If that container already exists it is started again, so
# data carries over. A container made before the port was limited to
# 127.0.0.1 keeps its old binding: scripts/db-lockdown.sh recreates it.
#
# Note: compose names its container boardofserv-db-1. If boardofserv-db from
# the fallback exists when compose becomes available, it holds port 5433;
# remove it first with `docker rm -f boardofserv-db` (the volume and data stay).
set -eu

NAME=boardofserv-db
IMAGE=postgres:16-alpine
VOLUME=boardofserv_boardofserv_pgdata

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed. Install Docker (or Colima) to run the local database." >&2
  exit 1
fi

has_compose() {
  docker compose version >/dev/null 2>&1
}

container_exists() {
  docker container inspect "$NAME" >/dev/null 2>&1
}

up() {
  if has_compose; then
    docker compose up -d db
  elif container_exists; then
    docker start "$NAME" >/dev/null
    echo "Started $NAME on port 5433."
  else
    docker run -d --name "$NAME" --restart unless-stopped \
      -e POSTGRES_USER=boardofserv \
      -e POSTGRES_PASSWORD=boardofserv \
      -e POSTGRES_DB=boardofserv \
      -p 127.0.0.1:5433:5432 \
      -v "$VOLUME":/var/lib/postgresql/data \
      "$IMAGE" >/dev/null
    echo "Created and started $NAME on port 5433."
  fi
}

down() {
  if has_compose; then
    docker compose stop db
  elif container_exists; then
    docker stop "$NAME" >/dev/null
    echo "Stopped $NAME. Data stays in the $VOLUME volume."
  else
    echo "$NAME does not exist. Nothing to stop."
  fi
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *)
    echo "usage: sh scripts/db.sh up|down" >&2
    exit 2
    ;;
esac
