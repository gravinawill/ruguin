# OTel Collector

OpenTelemetry Collector — ponto único de recepção de telemetria. Roda como o service `otel-collector` em `docker-compose.observability.yml`.

## Para que serve

É o ponto de entrada padrão (vendor-neutro) para as aplicações do monorepo exportarem traces via protocolo OTLP. Recebe e encaminha para o [Tempo](tempo.md) — as apps não precisam saber que o backend de tracing é o Tempo especificamente, só falam OTLP.

## Como funciona

- Imagem `otel/opentelemetry-collector-contrib:latest` (variante "contrib", com mais receivers/exporters que a build core).
- Config em `observability/otel/otel-collector-config.yaml`, montada read-only.
- Depende do [Tempo](tempo.md) estar de pé (`depends_on: [tempo]`).
- Duas portas, dois protocolos do mesmo OTLP:
  - `4317` — gRPC
  - `4318` — HTTP

## Como usar

```bash
pnpm infra:observability:up    # sobe runtime + observabilidade, incluindo o otel-collector
```

Nas apps do monorepo, aponte o exporter OpenTelemetry para:

- De um processo rodando no host (`pnpm dev`): `localhost:4317` (gRPC) ou `localhost:4318` (HTTP).
- De outro container na rede do compose: `otel-collector:4317` / `otel-collector:4318`.

Depois de exportado, o trace fica consultável no [Grafana](grafana.md), via datasource do [Tempo](tempo.md).
