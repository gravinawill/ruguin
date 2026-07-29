# Local Observability Stack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-29-local-observability-stack-design.md`
**Per-task breakdown (human-readable, Portuguese):** `docs/superpowers/plans/2026-07-29-local-observability-stack/` — this file is the canonical source for tooling (`task-brief`, `subagent-driven-development`); the directory version is the same content split one file per task.

**Goal:** Replace the `grafana/otel-lgtm` bundle in `infrastructure/local/docker-compose.tools.yml` with a configurable-as-code observability stack (Grafana, Prometheus, OTel Collector, Tempo, Loki, `postgres_exporter`, kminion, `node_exporter`, cAdvisor) that is useful from first boot — before any application exists — because it exposes metrics/logs of the infrastructure itself (Postgres, Kafka, host, containers), and ready to receive application telemetry via OTLP once Tasks 4+ of the transactional-email plan start instrumenting code.

**Architecture:** New file `infrastructure/local/docker-compose.observability.yml`, combinable via `-f` with `docker-compose.yml` (core) and `docker-compose.tools.yml` (dev tooling). Prometheus pulls from every exporter and the OTel Collector; every container across all three compose files ships logs straight to Loki via Docker's native log driver (no Promtail); Grafana queries all three (Prometheus/Tempo/Loki) as provisioned-as-code datasources, with dashboards and alerts also provisioned (no manual UI clicking).

**Tech Stack:** Docker Compose, Grafana, Prometheus, OpenTelemetry Collector (`contrib` distribution), Grafana Tempo, Grafana Loki (+ `grafana/loki-docker-driver` plugin), `prometheus-community/postgres_exporter`, kminion (Kafka), `prom/node-exporter`, `gcr.io/cadvisor/cadvisor`.

## Global Constraints

- Every observability config YAML lives under `infrastructure/local/observability/<tool>/`.
- Every observability Docker image uses the `latest` tag — same convention already used by the other dev-only tools in this repo (Conduktor, SonarQube, Adminer, k6): strict reproducibility isn't the goal here, it's a dev dependency, not core infra (Postgres/Valkey/Kafka/LocalStack, which ARE version-pinned).
- Every `x-logging` YAML anchor must be redeclared in each compose file that uses it — anchors don't cross files in a `docker compose -f a -f b` invocation; each `-f` is an independent YAML document.
- No observability service publishes a host port beyond the UIs/APIs worth debugging directly (Grafana `:3000`, Prometheus `:9090`, Tempo `:3200`, Loki `:3100`, OTel Collector `:4317`/`:4318` — the last one because host-run apps via `pnpm dev` need to reach it). Pure exporters (`postgres_exporter`, kminion, `node_exporter`, cAdvisor) are only reachable inside the compose network, by service name.
- All verification is manual (curl/UI) — same convention already used across the rest of `infrastructure/local/`, no automated infra tests.
- **Scope note:** production/deploy observability is out of scope — nothing here assumes a defined target in `infrastructure/deploy/`.
- **Scope note:** instrumenting the applications themselves (`apps/api-service`, `apps/dispatch-worker`) is out of scope — that's Tasks 4+ of the transactional-email plan; this plan only prepares the telemetry backend to receive it.
- **Scope note:** the two alert rules in Task 11 are a documented pattern, not an operational alerting pipeline — no notification channel is configured.

---

## Task 1: Postgres — monitoring role + `pg_stat_statements`

**Depends on:** `infrastructure/local/docker-compose.yml` and `infrastructure/local/postgres-init/` already existing (from the docker-compose infra plan).

**Files:**
- Modify: `infrastructure/local/docker-compose.yml` (`postgres` service)
- Create: `infrastructure/local/postgres-init/02-observability-setup.sh`

**Interfaces:**
- Produces: Postgres role `postgres_exporter` (password `postgres_exporter`, `pg_monitor` granted) and `pg_stat_statements` enabled on database `ruguin` — consumed by Task 6 via `DATA_SOURCE_NAME=postgresql://postgres_exporter:postgres_exporter@postgres:5432/ruguin?sslmode=disable`.

- [ ] **Step 1: Enable `pg_stat_statements` at Postgres boot**

Edit the `postgres` service in `infrastructure/local/docker-compose.yml`, adding a `command:` (the extension needs the lib preloaded at server boot — can't enable it later with just `CREATE EXTENSION`):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    command:
      - 'postgres'
      - '-c'
      - 'shared_preload_libraries=pg_stat_statements'
      - '-c'
      - 'pg_stat_statements.track=all'
    environment:
      POSTGRES_USER: ruguin
      POSTGRES_PASSWORD: ruguin
      POSTGRES_DB: ruguin
    # ... rest of the service (ports, volumes, healthcheck) unchanged
```

- [ ] **Step 2: Create the role and the extension**

Create `infrastructure/local/postgres-init/02-observability-setup.sh`:

```bash
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
```

```bash
chmod +x infrastructure/local/postgres-init/02-observability-setup.sh
```

- [ ] **Step 3: Recreate Postgres from scratch and verify**

`shared_preload_libraries` is only read at boot, and `postgres-init/` scripts only run against an empty volume:

```bash
docker compose -f infrastructure/local/docker-compose.yml down
docker volume rm ruguin_postgres_data
docker compose -f infrastructure/local/docker-compose.yml up -d postgres
```

Run:
```bash
docker compose -f infrastructure/local/docker-compose.yml exec -T postgres psql -U ruguin -d ruguin -c "SHOW shared_preload_libraries;"
docker compose -f infrastructure/local/docker-compose.yml exec -T postgres psql -U ruguin -d ruguin -c "\du postgres_exporter"
PGPASSWORD=postgres_exporter docker compose -f infrastructure/local/docker-compose.yml exec -T postgres psql -U postgres_exporter -d ruguin -c "SELECT count(*) FROM pg_stat_statements;"
```
Expected: the first shows `pg_stat_statements` in the list; the second shows role `postgres_exporter` with `pg_monitor` membership; the third runs with no permission error (`0` rows is fine — what matters is no access-denied error).

- [ ] **Step 4: Commit**

```bash
git add infrastructure/local/docker-compose.yml infrastructure/local/postgres-init/02-observability-setup.sh
git commit -m "feat(observability): add postgres_exporter monitoring role and pg_stat_statements"
```

---

## Task 2: Loki — remove the old bundle, wire the log driver everywhere

**Depends on:** Task 1

**Files:**
- Modify: `infrastructure/local/docker-compose.tools.yml` (remove `observability` service + `observability_data` volume; add `x-logging` anchor + apply to every service)
- Modify: `infrastructure/local/docker-compose.yml` (add `x-logging` anchor + apply to every service)
- Create: `infrastructure/local/docker-compose.observability.yml` (new file — Loki is the first service)
- Create: `infrastructure/local/observability/loki/loki-config.yaml`

**Interfaces:**
- Produces: Loki at `localhost:3100` (push/query API) — used by Task 9 (Grafana datasource) and by every container via the log driver.
- Produces: `x-logging: &loki-logging` anchor — each compose file declares its own (YAML anchors don't cross files), all pointing at `http://localhost:3100/loki/api/v1/push` (the driver runs on the host, in the Docker daemon, not inside the compose network — hence `localhost`, not `loki:3100`).

**Host prerequisite:** the Loki log driver is a Docker plugin, not installed by default — without it, every container with `logging: driver: loki` fails to start with an unknown-driver error.

- [ ] **Step 1: Install the Loki log plugin on the host**

```bash
docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
```
Expected: a permissions prompt (accept), and `docker plugin ls` finally shows `loki` with `ENABLED: true`.

- [ ] **Step 2: Remove the `grafana/otel-lgtm` bundle**

Edit `infrastructure/local/docker-compose.tools.yml`, removing the entire `observability` service (image `grafana/otel-lgtm:latest`) and the `observability_data:` entry from the `volumes:` block at the end of the file.

- [ ] **Step 3: Create the Loki config**

Create `infrastructure/local/observability/loki/loki-config.yaml`:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: info

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

query_range:
  results_cache:
    cache:
      embedded_cache:
        enabled: true
        max_size_mb: 100

schema_config:
  configs:
    - from: 2024-04-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  allow_structured_metadata: true
```

- [ ] **Step 4: Create `docker-compose.observability.yml` with the Loki service**

Create `infrastructure/local/docker-compose.observability.yml`:

```yaml
name: ruguin

x-logging: &loki-logging
  driver: loki
  options:
    loki-url: 'http://localhost:3100/loki/api/v1/push'
    loki-external-labels: 'compose_service={{.Name}}'
    loki-retries: '5'
    loki-batch-size: '400'

services:
  loki:
    image: grafana/loki:latest
    restart: unless-stopped
    ports:
      - '3100:3100'
    volumes:
      - ./observability/loki/loki-config.yaml:/etc/loki/local-config.yaml:ro
      - loki_data:/loki
    command: -config.file=/etc/loki/local-config.yaml
    logging: *loki-logging

volumes:
  loki_data:
```

- [ ] **Step 5: Wire the log driver into the existing services**

In `infrastructure/local/docker-compose.yml`, add right after `name: ruguin`:

```yaml
x-logging: &loki-logging
  driver: loki
  options:
    loki-url: 'http://localhost:3100/loki/api/v1/push'
    loki-external-labels: 'compose_service={{.Name}}'
    loki-retries: '5'
    loki-batch-size: '400'
```

And on **every** service (`postgres`, `redis`, `kafka`, `localstack`), add `logging: *loki-logging`. Example for `postgres`:

```yaml
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    command: [...]
    environment: [...]
    ports: [...]
    volumes: [...]
    healthcheck: [...]
    logging: *loki-logging
```

Repeat the same pattern (anchor at top of file + `logging: *loki-logging` on every service) in `infrastructure/local/docker-compose.tools.yml` (`conduktor`, `sonarqube`, `adminer`, `k6`).

- [ ] **Step 6: Bring everything up and verify logs reach Loki**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml up -d
sleep 15
curl -G -s 'http://localhost:3100/loki/api/v1/query_range' --data-urlencode 'query={compose_service="postgres"}' | grep -o '"status":"success"'
```
Expected: `docker plugin ls` already validated in Step 1; the `curl` prints `"status":"success"` (the full body has the `postgres` container's log lines inside `data.result`).

- [ ] **Step 7: Commit**

```bash
git add infrastructure/local/docker-compose.yml infrastructure/local/docker-compose.tools.yml infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/loki/
git commit -m "feat(observability): add Loki, remove otel-lgtm bundle, wire Docker log driver everywhere"
```

---

## Task 3: Tempo (traces)

**Depends on:** Task 2 (same `docker-compose.observability.yml` file, same `x-logging` anchor)

**Files:**
- Create: `infrastructure/local/observability/tempo/tempo.yaml`
- Modify: `infrastructure/local/docker-compose.observability.yml`

**Interfaces:**
- Consumes: `x-logging` anchor already declared in `docker-compose.observability.yml` (Task 2).
- Produces: Tempo reachable at `tempo:4317` (OTLP gRPC, compose-network only — used by Task 4) and `localhost:3200` (query API — used by Task 9).

- [ ] **Step 1: Create the Tempo config**

Create `infrastructure/local/observability/tempo/tempo.yaml`:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

ingester:
  max_block_duration: 5m

compactor:
  compaction:
    block_retention: 48h

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces
    wal:
      path: /var/tempo/wal
```

- [ ] **Step 2: Add the service to `docker-compose.observability.yml`**

```yaml
  tempo:
    image: grafana/tempo:latest
    restart: unless-stopped
    command: ['-config.file=/etc/tempo.yaml']
    volumes:
      - ./observability/tempo/tempo.yaml:/etc/tempo.yaml:ro
      - tempo_data:/var/tempo
    ports:
      - '3200:3200'
    logging: *loki-logging
```

Add `tempo_data:` to the `volumes:` block at the end of the file (alongside the existing `loki_data:`).

- [ ] **Step 3: Bring up and verify**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d tempo
sleep 5
curl -s http://localhost:3200/ready
```
Expected: response `ready`.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/tempo/
git commit -m "feat(observability): add Tempo for trace storage"
```

---

## Task 4: OTel Collector

**Depends on:** Task 3 (exports traces to Tempo)

**Files:**
- Create: `infrastructure/local/observability/otel/otel-collector-config.yaml`
- Modify: `infrastructure/local/docker-compose.observability.yml`

**Interfaces:**
- Consumes: `tempo:4317` (Task 3) as the trace-export destination.
- Produces: `localhost:4317` (gRPC) / `localhost:4318` (HTTP) — OTLP endpoint host-run apps (via `pnpm dev`, Tasks 4+ of the email plan) should target. Also produces `otel-collector:8888` (Collector's own internal metrics) and `otel-collector:8889` (OTLP metrics received, re-exposed as Prometheus format) — both used by Task 5.

- [ ] **Step 1: Create the Collector config**

Create `infrastructure/local/observability/otel/otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  debug:
    verbosity: basic

service:
  telemetry:
    metrics:
      address: 0.0.0.0:8888
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/tempo, debug]
```

- [ ] **Step 2: Add the service to `docker-compose.observability.yml`**

```yaml
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    restart: unless-stopped
    command: ['--config=/etc/otel-collector-config.yaml']
    volumes:
      - ./observability/otel/otel-collector-config.yaml:/etc/otel-collector-config.yaml:ro
    ports:
      - '4317:4317'
      - '4318:4318'
    depends_on:
      - tempo
    logging: *loki-logging
```

- [ ] **Step 3: Bring up and verify**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d otel-collector
sleep 5
curl -s http://localhost:8889/metrics > /dev/null && echo "collector metrics endpoint OK"
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml logs otel-collector --tail 20
```
Since no app is sending OTLP yet, `:8889` responds `200` with no application metrics — what matters here is confirming the process started and the endpoint responds, and that the logs show no errors and that the `metrics`/`traces` pipelines started.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/otel/
git commit -m "feat(observability): add OTel Collector (OTLP receiver, Prometheus + Tempo exporters)"
```

---

## Task 5: Prometheus

**Depends on:** Task 4

**Files:**
- Create: `infrastructure/local/observability/prometheus/prometheus.yml`
- Modify: `infrastructure/local/docker-compose.observability.yml`

**Interfaces:**
- Consumes: `otel-collector:8888`/`:8889` (Task 4).
- Produces: `localhost:9090` — used by Task 9 (Grafana datasource) and Tasks 6/7/8/11 (scrape/alerting targets this `prometheus.yml` already reserves).

The `prometheus.yml` below already declares scrape targets for `postgres_exporter` (Task 6), kminion (Task 7), and `node_exporter`/cAdvisor (Task 8) — none of those services exist yet at this point in the plan, so they show as `DOWN` at `http://localhost:9090/targets` until the corresponding tasks land. This is expected — it avoids re-editing `prometheus.yml` on every subsequent task.

- [ ] **Step 1: Create the Prometheus config**

Create `infrastructure/local/observability/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ['localhost:9090']

  - job_name: otel-collector
    static_configs:
      - targets: ['otel-collector:8888', 'otel-collector:8889']

  - job_name: postgres
    static_configs:
      - targets: ['postgres-exporter:9187']

  - job_name: kafka
    static_configs:
      - targets: ['kminion:8080']

  - job_name: node
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: cadvisor
    static_configs:
      - targets: ['cadvisor:8080']
```

- [ ] **Step 2: Add the service to `docker-compose.observability.yml`**

```yaml
  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=15d'
    volumes:
      - ./observability/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    ports:
      - '9090:9090'
    depends_on:
      - otel-collector
    logging: *loki-logging
```

Add `prometheus_data:` to the `volumes:` block at the end of the file.

- [ ] **Step 3: Bring up and verify**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d prometheus
sleep 5
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"otel-collector"'
```
Expected: appears at least once (the `otel-collector` job exists and is being scraped — `postgres`/`kafka`/`node`/`cadvisor` show as `down` until Tasks 6-8, which is expected).

- [ ] **Step 4: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/prometheus/
git commit -m "feat(observability): add Prometheus, scrape configs for all planned exporters"
```

---

## Task 6: `postgres_exporter`

**Depends on:** Task 1 (`postgres_exporter` role), Task 5 (Prometheus already references this target)

**Files:**
- Modify: `infrastructure/local/docker-compose.observability.yml`

**Interfaces:**
- Consumes: `postgres_exporter` role (Task 1), the `postgres` service from `infrastructure/local/docker-compose.yml`.
- Produces: `postgres-exporter:9187/metrics` — target already configured in Task 5's `prometheus.yml` under job `postgres`; used by Tasks 10 (dashboard) and 11 (alert).

- [ ] **Step 1: Add the service to `docker-compose.observability.yml`**

```yaml
  postgres-exporter:
    image: quay.io/prometheuscommunity/postgres-exporter:latest
    restart: unless-stopped
    environment:
      DATA_SOURCE_NAME: 'postgresql://postgres_exporter:postgres_exporter@postgres:5432/ruguin?sslmode=disable'
    depends_on:
      postgres:
        condition: service_healthy
    logging: *loki-logging
```

`postgres` is defined in `infrastructure/local/docker-compose.yml`, not this file — cross-file `depends_on` works because both files are combined via `-f` in the same `docker compose` command.

- [ ] **Step 2: Bring up and verify**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d postgres-exporter
sleep 5
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"postgres".\{0,20\}"health":"up"'
```
Expected: the `postgres` job appears with `"health":"up"`.

- [ ] **Step 3: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml
git commit -m "feat(observability): add postgres_exporter"
```

---

## Task 7: kminion (Kafka metrics)

**Depends on:** Task 5 (Prometheus already references this target)

**Files:**
- Create: `infrastructure/local/observability/kminion/kminion-config.yaml`
- Modify: `infrastructure/local/docker-compose.observability.yml`

**Interfaces:**
- Consumes: `kafka:29092` (`INTERNAL` listener, `infrastructure/local/docker-compose.yml`).
- Produces: `kminion:8080/metrics` — target already configured in Task 5's `prometheus.yml` under job `kafka`; used by Tasks 10 (dashboards) and 11 (lag alert).

- [ ] **Step 1: Create the kminion config**

Create `infrastructure/local/observability/kminion/kminion-config.yaml`:

```yaml
kafka:
  brokers:
    - 'kafka:29092'

minion:
  consumer-groups:
    enabled: true
    scrape-interval: 30s
  topics:
    enabled: true
    scrape-interval: 30s
    info-metric:
      enabled: true
```

- [ ] **Step 2: Add the service to `docker-compose.observability.yml`**

```yaml
  kminion:
    image: redpandadata/kminion:latest
    restart: unless-stopped
    command: ['-config.filepath=/etc/kminion/config.yaml']
    volumes:
      - ./observability/kminion/kminion-config.yaml:/etc/kminion/config.yaml:ro
    depends_on:
      kafka:
        condition: service_healthy
    logging: *loki-logging
```

- [ ] **Step 3: Bring up and verify**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d kminion
sleep 10
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"kafka".\{0,20\}"health":"up"'
```
Expected: the `kafka` job appears with `"health":"up"`.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/kminion/
git commit -m "feat(observability): add kminion for Kafka metrics"
```

---

## Task 8: `node_exporter` + cAdvisor (host and container metrics)

**Depends on:** Task 5 (Prometheus already references these targets)

**Files:**
- Modify: `infrastructure/local/docker-compose.observability.yml`

**Interfaces:**
- Produces: `node-exporter:9100/metrics` and `cadvisor:8080/metrics` — targets already configured in Task 5's `prometheus.yml` under jobs `node` and `cadvisor`; used by Task 10 (dashboards).

- [ ] **Step 1: Add both services to `docker-compose.observability.yml`**

```yaml
  node-exporter:
    image: prom/node-exporter:latest
    restart: unless-stopped
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    logging: *loki-logging

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    restart: unless-stopped
    privileged: true
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    logging: *loki-logging
```

- [ ] **Step 2: Bring up and verify**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d node-exporter cadvisor
sleep 10
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"node".\{0,20\}"health":"up"'
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"cadvisor".\{0,20\}"health":"up"'
```
Expected: both jobs appear with `"health":"up"`. If `cadvisor` fails to boot on macOS (error related to `/sys` or `/var/lib/docker` not existing as expected inside the Docker Desktop/OrbStack VM), document the exact error — it's a known cAdvisor-outside-native-Linux limitation, not a bug in this task.

- [ ] **Step 3: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml
git commit -m "feat(observability): add node_exporter and cAdvisor for host/container metrics"
```

---

## Task 9: Grafana + datasources

**Depends on:** Task 5 (Prometheus), Task 4 (implies Task 3/Tempo already up), Task 2 (Loki)

**Files:**
- Create: `infrastructure/local/observability/grafana/provisioning/datasources/datasources.yaml`
- Create: `infrastructure/local/observability/grafana/provisioning/dashboards/dashboards.yaml`
- Modify: `infrastructure/local/docker-compose.observability.yml`

**Interfaces:**
- Consumes: `prometheus:9090` (Task 5), `tempo:3200` (Task 3), `loki:3100` (Task 2).
- Produces: Grafana at `localhost:3000` (login `admin`/`admin`); datasource `uid: prometheus` and `uid: tempo` — referenced by Task 11 (alert rules). Dashboard provisioning folder `/var/lib/grafana/dashboards` inside the container — used by Task 10.

- [ ] **Step 1: Create the datasource provisioning**

Create `infrastructure/local/observability/grafana/provisioning/datasources/datasources.yaml`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    jsonData:
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo

  - name: Tempo
    uid: tempo
    type: tempo
    access: proxy
    url: http://tempo:3200

  - name: Loki
    uid: loki
    type: loki
    access: proxy
    url: http://loki:3100
```

- [ ] **Step 2: Create the dashboard provider (Task 10 fills the folder)**

Create `infrastructure/local/observability/grafana/provisioning/dashboards/dashboards.yaml`:

```yaml
apiVersion: 1

providers:
  - name: 'infra'
    orgId: 1
    folder: 'Infra'
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    options:
      path: /var/lib/grafana/dashboards
```

- [ ] **Step 3: Add the service to `docker-compose.observability.yml`**

```yaml
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_AUTH_ANONYMOUS_ENABLED: 'false'
    ports:
      - '3000:3000'
    volumes:
      - ./observability/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./observability/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus
      - tempo
      - loki
    logging: *loki-logging
```

Add `grafana_data:` to the `volumes:` block at the end of the file. The `./observability/grafana/dashboards` folder doesn't exist yet — Task 10 creates it; until then the provider mounts an empty folder, no error.

- [ ] **Step 4: Bring up and verify the datasources**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d grafana
sleep 10
curl -s -u admin:admin http://localhost:3000/api/datasources | grep -o '"name":"[A-Za-z]*"'
```
Expected: prints `"name":"Prometheus"`, `"name":"Tempo"`, and `"name":"Loki"` — all three auto-provisioned, no manual clicking.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/grafana/
git commit -m "feat(observability): add Grafana with provisioned Prometheus/Tempo/Loki datasources"
```

---

## Task 10: Provisioned dashboards

**Depends on:** Task 9 (Grafana + dashboard provider), Task 6 (`postgres_exporter`), Task 7 (kminion), Task 8 (`node_exporter`/cAdvisor)

**Files:**
- Create: `infrastructure/local/observability/grafana/dashboards/fix-datasource-refs.mjs`
- Create: `infrastructure/local/observability/grafana/dashboards/*.json` (downloaded, not hand-written)

**Interfaces:**
- Consumes: Task 9's dashboard provider (reads `/var/lib/grafana/dashboards`, mounted from this folder); datasource `Prometheus` (Task 9); real data exposed by `postgres_exporter` (Task 6), kminion (Task 7), `node_exporter`/cAdvisor (Task 8).

Dashboards exported from `grafana.com` reference the datasource via a template variable (`${DS_PROMETHEUS}`), only resolved automatically in the manual UI *import* flow — file-based provisioning (what we use here, Task 9) doesn't resolve it on its own, so a script post-processes the downloaded JSON, swapping the variable for the literal datasource name (`Prometheus`, `Loki` — the same names defined in `datasources.yaml` in Task 9).

- [ ] **Step 1: Download the community dashboards**

```bash
mkdir -p infrastructure/local/observability/grafana/dashboards
curl -sL 'https://grafana.com/api/dashboards/1860/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/node-exporter-full.json
curl -sL 'https://grafana.com/api/dashboards/9628/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/postgres-overview.json
curl -sL 'https://grafana.com/api/dashboards/15798/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/docker-monitoring.json
curl -sL 'https://grafana.com/api/dashboards/14012/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/kminion-cluster.json
curl -sL 'https://grafana.com/api/dashboards/14013/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/kminion-topic.json
curl -sL 'https://grafana.com/api/dashboards/14014/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/kminion-groups.json
```

- [ ] **Step 2: Create the script that fixes datasource references**

Create `infrastructure/local/observability/grafana/dashboards/fix-datasource-refs.mjs`:

```javascript
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dashboards exported from grafana.com reference the datasource via a template
// variable (${DS_PROMETHEUS}, ${DS_LOKI}), only resolved automatically by the manual
// UI import flow. In file-based provisioning (Task 9/10) that variable is left
// unresolved and the dashboard loads with no data -- so we swap it for the literal
// datasource name, the same one defined in provisioning/datasources/datasources.yaml.
const REPLACEMENTS = {
  '${DS_PROMETHEUS}': 'Prometheus',
  '${DS_LOKI}': 'Loki',
};

const dir = dirname(fileURLToPath(import.meta.url));

for (const file of readdirSync(dir)) {
  if (!file.endsWith('.json')) continue;

  const path = join(dir, file);
  let content = readFileSync(path, 'utf8');

  for (const [placeholder, replacement] of Object.entries(REPLACEMENTS)) {
    content = content.replaceAll(placeholder, replacement);
  }

  writeFileSync(path, content);
  console.log(`fixed datasource refs: ${file}`);
}
```

- [ ] **Step 3: Run the script**

```bash
node infrastructure/local/observability/grafana/dashboards/fix-datasource-refs.mjs
```
Expected: prints one `fixed datasource refs: <file>.json` line for each of the 6 dashboards downloaded in Step 1.

- [ ] **Step 4: Reload Grafana and verify**

The dashboard provider (Task 9) already has `updateIntervalSeconds: 30`, so it reloads on its own — but to check immediately:

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml restart grafana
sleep 10
curl -s -u admin:admin http://localhost:3000/api/search?folderIds=0 | grep -o '"title":"[^"]*"'
```
Expected: lists the 6 dashboards by `title`. Open `http://localhost:3000` in the browser, go into the "Infra" folder, open "PostgreSQL Database", and confirm the panels show real data (not "No data") — proof that Task 6 (`postgres_exporter`) is actually feeding Prometheus and that the datasource resolution (Step 2/3) worked.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/local/observability/grafana/dashboards/
git commit -m "feat(observability): provision community dashboards (node, postgres, docker, kafka)"
```

---

## Task 11: Provisioned alerts (2 examples)

**Depends on:** Task 9 (datasource `uid: prometheus`), Task 6 (`postgres_exporter`, metric used by the second alert), Task 7 (kminion, metric used by the first alert)

**Files:**
- Create: `infrastructure/local/observability/grafana/provisioning/alerting/rules.yaml`

**Interfaces:**
- Consumes: datasource `uid: prometheus` (Task 9); metric `kminion_kafka_consumer_group_topic_lag` (kminion, Task 7); metrics `pg_stat_activity_count` and `pg_settings_max_connections` (`postgres_exporter`, Task 6, exporter's standard metric names).

Two example alerts, provisioned as code in Grafana's native Alerting — they document the pattern (rule + condition + threshold), not an operational alerting pipeline: no notification channel (email/Slack/PagerDuty) is configured, so alerts fire and stay visible in the Grafana UI, but nobody gets notified. Wiring a real notification channel is deferred (see the spec's "Decisões em aberto").

- [ ] **Step 1: Create the alerting rules**

Create `infrastructure/local/observability/grafana/provisioning/alerting/rules.yaml`:

```yaml
apiVersion: 1

groups:
  - orgId: 1
    name: infra-alerts
    folder: Infra
    interval: 1m
    rules:
      - uid: kafka-consumer-lag-high
        title: Kafka consumer lag alto
        condition: C
        data:
          - refId: A
            relativeTimeRange:
              from: 600
              to: 0
            datasourceUid: prometheus
            model:
              expr: max(kminion_kafka_consumer_group_topic_lag) by (group_id)
              instant: true
              refId: A
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expr: ''
              conditions:
                - evaluator:
                    type: gt
                    params: [1000]
                  operator:
                    type: and
                  query:
                    params: [A]
              refId: C
        noDataState: NoData
        execErrState: Error
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'Consumer group {{ $labels.group_id }} está com lag acima de 1000 mensagens'

      - uid: postgres-connections-near-limit
        title: Postgres perto do limite de conexões
        condition: C
        data:
          - refId: A
            relativeTimeRange:
              from: 600
              to: 0
            datasourceUid: prometheus
            model:
              expr: sum(pg_stat_activity_count) / pg_settings_max_connections * 100
              instant: true
              refId: A
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expr: ''
              conditions:
                - evaluator:
                    type: gt
                    params: [80]
                  operator:
                    type: and
                  query:
                    params: [A]
              refId: C
        noDataState: NoData
        execErrState: Error
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'Postgres usando mais de 80% das conexões disponíveis'
```

- [ ] **Step 2: Reload Grafana and verify**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml restart grafana
sleep 10
curl -s -u admin:admin http://localhost:3000/api/v1/provisioning/alert-rules | grep -o '"title":"[^"]*"'
```
Expected: prints `"title":"Kafka consumer lag alto"` and `"title":"Postgres perto do limite de conexões"`. Open `http://localhost:3000/alerting/list` in the browser and confirm both rules show state `Normal` (not `Pending`/`Error`) — `Error` usually means the referenced metric doesn't exist yet in Prometheus (confirm Tasks 6 and 7 are `up` in `/targets`).

- [ ] **Step 3: Commit**

```bash
git add infrastructure/local/observability/grafana/provisioning/alerting/
git commit -m "feat(observability): provision example alert rules (Kafka lag, Postgres connections)"
```

---

## Task 12: Scripts, README, end-to-end verification

**Depends on:** Tasks 1-11

**Files:**
- Modify: `package.json` (monorepo root)
- Modify: `infrastructure/local/README.md`

**Interfaces:**
- Consumes: every service from Tasks 1-11.
- Produces: `pnpm infra:observability:up`/`:down`, `pnpm infra:all:up`/`:down` — commands any future task (including Tasks 4+ of the transactional-email plan) can assume exist.

- [ ] **Step 1: Add the scripts to root `package.json`**

Edit the `scripts` block of `package.json`, keeping alphabetical order (same convention already used by the existing `infra:*` scripts):

```json
"infra:all:down": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml down",
"infra:all:up": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml up -d",
"infra:observability:down": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml down",
"infra:observability:up": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d",
```

- [ ] **Step 2: Update `infrastructure/local/README.md`**

In the paragraph describing the directory's files, add a mention of the third compose file:

```markdown
- `docker-compose.observability.yml` — Grafana + Prometheus + OTel Collector + Tempo + Loki + infra exporters (Postgres/Kafka/host/containers). Separate from `docker-compose.tools.yml` because observability is its own category, and from `docker-compose.yml` because none of these components is a runtime dependency of the product.
```

In the commands section, add:

```markdown
pnpm infra:observability:up    # runtime + observability (grafana, prometheus, otel-collector, tempo, loki, exporters)
pnpm infra:observability:down  # tear down runtime + observability
pnpm infra:all:up              # EVERYTHING (runtime + tools + observability)
pnpm infra:all:down            # tear down EVERYTHING
```

In the required-setup section, add (alongside the existing LocalStack token one):

```markdown
## Required setup: Loki log plugin

`docker-compose.observability.yml` wires the Loki log driver into every container across all three compose files. Without the plugin installed on the host, any `docker compose ... up` fails:

```bash
docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
```
```

In the addresses-and-credentials table, add:

```markdown
| Grafana | http://localhost:3000 | `admin` / `admin` |
| Prometheus | http://localhost:9090 | — |
| Tempo | http://localhost:3200 | — |
| Loki | http://localhost:3100 | — (queried through Grafana, not directly) |
| OTel Collector | `localhost:4317` (gRPC) / `localhost:4318` (HTTP) from host, `otel-collector:4317`/`:4318` from other containers | point apps' OpenTelemetry exporter here |
```

Remove, if still present, the old "Observabilidade (Grafana)" / "Observabilidade (OTLP)" rows that pointed at the `grafana/otel-lgtm` bundle — superseded by the rows above.

- [ ] **Step 3: End-to-end verification — bring everything up from scratch**

```bash
pnpm infra:all:down 2>/dev/null || true
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml down -v
pnpm infra:all:up
sleep 30
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml ps
```
Expected: every service (core + tools + observability, ~18 containers) shows `running`/`healthy`.

- [ ] **Step 4: Verify all Prometheus targets are `up`**

```bash
curl -s http://localhost:9090/api/v1/targets | grep -o '"health":"[a-z]*"' | sort | uniq -c
```
Expected: only `"health":"up"` in the output — zero `"health":"down"`. If any target is `down`, check `docker compose logs <service>` for the corresponding exporter before considering the task done.

- [ ] **Step 5: Verify dashboards load real data**

Open `http://localhost:3000` (login `admin`/`admin`), go into the "Infra" folder, and visually confirm at least "PostgreSQL Database" and "Node Exporter Full" show graphs with data (not "No data") — final proof that scrape configs, datasources, and the template-variable resolution (Task 10) are all correct together.

- [ ] **Step 6: Commit**

```bash
git add package.json infrastructure/local/README.md
git commit -m "feat(observability): add infra:observability/:all scripts, document setup in README"
```
