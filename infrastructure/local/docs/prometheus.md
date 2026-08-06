# Prometheus

Coleta e armazenamento de métricas. Roda como o service `prometheus` em `docker-compose.observability.yml`.

## Para que serve

Faz scrape (pull periódico) das métricas expostas pelos exporters da stack e as deixa consultáveis (PromQL) pelo [Grafana](grafana.md) — é o "M" (Metrics) da stack LGTM.

## Como funciona

- Imagem `prom/prometheus:latest`.
- Retenção configurada para 15 dias (`--storage.tsdb.retention.time=15d`) — suficiente para desenvolvimento local sem crescer o volume indefinidamente.
- Config em `observability/prometheus/prometheus.yml`, montada read-only — é lá que os scrape targets (postgres-exporter, kminion, node-exporter, cadvisor, otel-collector, etc.) estão declarados.
- Depende do [OTel Collector](otel-collector.md) estar de pé (`depends_on`), já que ele também expõe métricas próprias.
- Dados persistidos no volume `prometheus_data`.
- Porta `9090`.

## Como usar

```bash
pnpm infra:observability:up    # sobe runtime + observabilidade, incluindo o prometheus
```

- Endereço: http://localhost:9090 — dá para rodar queries PromQL direto na UI dele, mas o uso normal é via dashboards no [Grafana](grafana.md) (datasource já provisionado automaticamente).
