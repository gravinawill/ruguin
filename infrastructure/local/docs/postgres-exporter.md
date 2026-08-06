# postgres-exporter

Exporter de métricas do Postgres para o Prometheus. Roda como o service `postgres-exporter` em `docker-compose.observability.yml`.

## Para que serve

Traduz o estado interno do [Postgres](postgres.md) (conexões ativas, cache hit ratio, tamanho de tabelas, locks, etc. — via `pg_stat_statements`, já habilitado no service `postgres`) em métricas que o [Prometheus](prometheus.md) consegue coletar, alimentando o dashboard "Postgres Overview" no [Grafana](grafana.md).

## Como funciona

- Imagem `quay.io/prometheuscommunity/postgres-exporter:latest`.
- Conecta no Postgres com uma role dedicada, `postgres_exporter` (criada por `postgres-init/02-observability-setup.sh` no primeiro boot — só existe se a stack de observabilidade já foi usada alguma vez nesse volume).
- `DATA_SOURCE_NAME: postgresql://postgres_exporter:postgres_exporter@postgres:5432/ruguin?sslmode=disable`.
- Depende do [Postgres](postgres.md) estar `healthy`.
- Sem porta exposta ao host — só o Prometheus, dentro da rede do compose, faz scrape dele.

## Como usar

```bash
pnpm infra:observability:up    # sobe runtime + observabilidade, incluindo o postgres-exporter
```

Não há UI própria — as métricas aparecem no dashboard "Postgres Overview" do [Grafana](grafana.md) (`observability/grafana/dashboards/postgres-overview.json`, provisionado automaticamente).
