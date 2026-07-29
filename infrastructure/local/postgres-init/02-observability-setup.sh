#!/bin/sh
set -e

# Runs only on first boot of the postgres container (empty volume). Creates the
# read-only role postgres_exporter (Task 6, infrastructure/local/docker-compose.observability.yml)
# -- never the ruguin superuser -- and enables pg_stat_statements on the ruguin
# database for per-query metrics. Depends on shared_preload_libraries=pg_stat_statements
# already set via the postgres service's `command:` (docker-compose.yml) -- without it
# the CREATE EXTENSION fails.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres_exporter') THEN
	    CREATE USER postgres_exporter WITH PASSWORD 'postgres_exporter';
	  END IF;
	END
	\$\$;
	GRANT pg_monitor TO postgres_exporter;
	GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO postgres_exporter;
	CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EOSQL
