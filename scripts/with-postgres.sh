#!/usr/bin/env bash
#
# with-postgres.sh — Boot an ephemeral PostgreSQL 16 instance, then run a command
# against it, then shut it down. Everything happens inside ONE shell invocation
# because this sandbox terminates the process group when a tool call returns, so a
# long-lived background DB cannot survive between separate commands.
#
# Usage:
#   scripts/with-postgres.sh <command> [args...]
#
# Environment exported to the child command:
#   PGHOST=/var/run/pgsock  PGPORT=5433  PGUSER=postgres  PGDATABASE=garudai
#   DATABASE_URL / APP_DATABASE_URL (see below)
#
# Two roles are created:
#   postgres  — superuser (bypasses RLS)  — used ONLY for migrations/admin
#   garudai_app — NOSUPERUSER, NOBYPASSRLS — used by the application at runtime,
#                  so Row Level Security is actually enforced.
#
set -euo pipefail

PGBIN=/usr/bin
PGDATA=/var/lib/pgsql/garudai-data
SOCKDIR=/var/run/pgsock
PGPORT=5433
APP_DB=garudai
APP_ROLE=garudai_app
APP_ROLE_PASS=app_dev_password

log() { echo "[with-postgres] $*" >&2; }

# --- ensure the pgsql OS user exists (postgres refuses to run as root) ---
if ! id pgsql >/dev/null 2>&1; then
  useradd -m pgsql
fi

mkdir -p "$SOCKDIR"
chmod 777 "$SOCKDIR"
mkdir -p "$(dirname "$PGDATA")"
chown -R pgsql:pgsql "$(dirname "$PGDATA")"

# --- initialize the data dir once ---
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  log "initializing data directory"
  su pgsql -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust --encoding=UTF8 -A trust" >/dev/null
  {
    echo "port = $PGPORT"
    echo "listen_addresses = ''"
    echo "unix_socket_directories = '$SOCKDIR'"
    echo "unix_socket_permissions = 0777"
    echo "fsync = off"
    echo "synchronous_commit = off"
    echo "full_page_writes = off"
  } >> "$PGDATA/postgresql.conf"
fi

# clean any stale socket/pid
rm -f "$SOCKDIR/.s.PGSQL.$PGPORT" "$SOCKDIR/.s.PGSQL.$PGPORT.lock" 2>/dev/null || true
rm -f "$PGDATA/postmaster.pid" 2>/dev/null || true

# --- start postgres (daemonized via pg_ctl) ---
log "starting postgres"
su pgsql -c "$PGBIN/pg_ctl -D $PGDATA -l $PGDATA/startup.log -w -t 30 start" >&2

cleanup() {
  log "stopping postgres"
  su pgsql -c "$PGBIN/pg_ctl -D $PGDATA -m immediate stop" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- wait for readiness ---
for i in $(seq 1 30); do
  if su pgsql -c "$PGBIN/pg_isready -h $SOCKDIR -p $PGPORT -U postgres" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# --- create app database + non-superuser app role (idempotent) ---
PSQL="$PGBIN/psql -h $SOCKDIR -p $PGPORT -U postgres -v ON_ERROR_STOP=1"
su pgsql -c "$PSQL -d postgres -tc \"SELECT 1 FROM pg_database WHERE datname='$APP_DB'\" | grep -q 1 || $PSQL -d postgres -c \"CREATE DATABASE $APP_DB\"" >/dev/null
su pgsql -c "$PSQL -d postgres -tc \"SELECT 1 FROM pg_roles WHERE rolname='$APP_ROLE'\" | grep -q 1 || $PSQL -d postgres -c \"CREATE ROLE $APP_ROLE LOGIN PASSWORD '$APP_ROLE_PASS' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE\"" >/dev/null

log "postgres ready on $SOCKDIR:$PGPORT (db=$APP_DB, app role=$APP_ROLE)"

# --- export connection env for the child command ---
export PGHOST="$SOCKDIR"
export PGPORT="$PGPORT"
export PGUSER=postgres
export PGDATABASE="$APP_DB"
# Admin/superuser URL — migrations only. encodeURIComponent of socket dir path.
export ADMIN_DATABASE_URL="postgresql://postgres@/${APP_DB}?host=${SOCKDIR}&port=${PGPORT}"
# Application URL — non-superuser, RLS enforced.
export APP_DATABASE_URL="postgresql://${APP_ROLE}:${APP_ROLE_PASS}@/${APP_DB}?host=${SOCKDIR}&port=${PGPORT}"
export DATABASE_URL="$APP_DATABASE_URL"
export PG_SOCK_DIR="$SOCKDIR"
export PG_APP_ROLE="$APP_ROLE"

# --- run the requested command ---
log "running: $*"
"$@"
