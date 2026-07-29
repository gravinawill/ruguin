# Task 6: `postgres_exporter`

**Depende de:** Task 1 (role `postgres_exporter`), Task 5 (Prometheus já referencia este alvo)
**Próximas tasks que dependem desta:** 10 (dashboard do Postgres), 11 (alert de conexões)

## Contexto

Expõe métricas do Postgres pro Prometheus, autenticado com a role `pg_monitor` da Task 1 — nunca com o `ruguin` (superusuário compartilhado por Conduktor/SonarQube/Adminer).

## Arquivos

- Modificar: `infrastructure/local/docker-compose.observability.yml`

## Interfaces

- **Consome:** role `postgres_exporter` (Task 1), serviço `postgres` de `infrastructure/local/docker-compose.yml`.
- **Produz:** `postgres-exporter:9187/metrics` — alvo já configurado no `prometheus.yml` da Task 5 sob o job `postgres`; usado pelas Tasks 10 (dashboard) e 11 (alert).

## Passos

- [ ] **Passo 1: Adicionar o serviço em `docker-compose.observability.yml`**

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

> `postgres` é definido em `infrastructure/local/docker-compose.yml`, não neste arquivo — `depends_on` funciona entre arquivos porque ambos são combinados via `-f` no mesmo comando `docker compose`.

- [ ] **Passo 2: Subir e verificar**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d postgres-exporter
sleep 5
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"postgres".\{0,20\}"health":"up"'
```
Esperado: aparece o job `postgres` com `"health":"up"` (o Prometheus já estava configurado pra fazer scrape deste alvo desde a Task 5 — só precisava do serviço existir).

- [ ] **Passo 3: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml
git commit -m "feat(observability): add postgres_exporter"
```
