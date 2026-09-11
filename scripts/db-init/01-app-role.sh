#!/bin/bash
# Runs once on first Postgres container init. Creates the NON-superuser,
# NOBYPASSRLS application role that the API/worker connect as, so PostgreSQL
# Row Level Security is enforced. Password comes from APP_DB_PASSWORD (compose)
# or defaults to the dev value.
set -e
APP_PW="${APP_DB_PASSWORD:-app_dev_password}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "garudai" <<-SQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garudai_app') THEN
      CREATE ROLE garudai_app LOGIN PASSWORD '${APP_PW}'
        NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
  END
  \$\$;
  GRANT USAGE ON SCHEMA public TO garudai_app;
SQL
echo "[db-init] garudai_app role ready"
