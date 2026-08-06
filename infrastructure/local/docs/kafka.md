# Kafka

Broker de mensageria do produto. Roda como o service `kafka` em `docker-compose.yml`.

## Para que serve

É o barramento de eventos usado pelo padrão outbox/consumers do monorepo (ex.: `apps/ses-webhook-ingestor` consome `email.status.updated`). Broker único, suficiente para desenvolvimento local.

## Como funciona

- Imagem `apache/kafka:4.3.1`, rodando em modo **KRaft** — sem ZooKeeper, o próprio broker atua como controller (`KAFKA_PROCESS_ROLES: broker,controller`).
- Três listeners, cada um para uma audiência diferente:
  - `PLAINTEXT` (`0.0.0.0:9092`, anunciado como `localhost:9092`) — para processos rodando no host (as apps do monorepo via `pnpm dev`, testes de integração).
  - `INTERNAL` (`0.0.0.0:29092`, anunciado como `kafka:29092`) — para outros containers da mesma rede do compose (ex.: Conduktor), que não conseguem resolver `localhost` de volta para o container do Kafka.
  - `CONTROLLER` (`0.0.0.0:9093`) — tráfego interno do próprio KRaft.
- Replication factor e min ISR travados em `1` (`KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR`, `KAFKA_TRANSACTION_STATE_LOG_*`) — não há sentido em replicação com um broker só.
- Healthcheck via `kafka-broker-api-versions.sh`.

## Como usar

```bash
pnpm infra:up          # sobe o kafka junto com o resto do runtime
```

- Do host (apps, testes): `localhost:9092`.
- De outro container no compose: `kafka:29092`.
- Para inspecionar tópicos/consumers via UI, suba o [Conduktor](conduktor.md) (`pnpm infra:tools:up`), que já vem pré-configurado apontando para `kafka:29092`.
- Métricas (lag de consumer, throughput por tópico) ficam disponíveis via [Kminion](kminion.md) + [Prometheus](prometheus.md)/[Grafana](grafana.md) (`pnpm infra:observability:up`).
