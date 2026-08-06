# Kminion

Exporter de métricas do Kafka para o Prometheus. Roda como o service `kminion` em `docker-compose.observability.yml`.

## Para que serve

Expõe métricas do [Kafka](kafka.md) — lag de consumer group, throughput por tópico/partição, contagem de brokers — para o [Prometheus](prometheus.md), alimentando os dashboards "Kminion Cluster/Groups/Topic" no [Grafana](grafana.md).

## Como funciona

- Imagem `redpandadata/kminion:latest`.
- Config via env var `CONFIG_FILEPATH: /etc/kminion/config.yaml` — **não** existe flag de CLI `-config.filepath` nessa imagem (comportamento verificado contra `redpandadata/kminion:latest`; só carrega YAML pela env var).
- Config em `observability/kminion/kminion-config.yaml`, montada read-only.
- Depende do [Kafka](kafka.md) estar `healthy`.
- Sem porta exposta ao host — só o Prometheus, dentro da rede do compose, faz scrape dele.

## Como usar

```bash
pnpm infra:observability:up    # sobe runtime + observabilidade, incluindo o kminion
```

Não há UI própria — as métricas aparecem nos dashboards "Kminion Cluster", "Kminion Groups" e "Kminion Topic" do [Grafana](grafana.md).
