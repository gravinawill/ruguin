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

Nas apps do monorepo, aponte o exporter OpenTelemetry para cá via `OTEL_EXPORTER_OTLP_ENDPOINT`. **Atenção ao formato:** o SDK do core-server (`create-tracing-sdk.ts`, `resolveOtlpEndpoint`) repassa essa env var direto para o `url` do `OTLPTraceExporter` — sem auto-completar `/v1/traces` como a variante genérica da spec OTel faria. O valor precisa vir com scheme e path completos:

- De um processo rodando no host (`pnpm dev`): `http://localhost:4318/v1/traces` (HTTP) — é o próprio default do core-server quando a env var não é setada.
- De outro container na rede do compose: `http://otel-collector:4318/v1/traces`.

(Isso é específico de como o core-server configura o exporter. Um app que use o SDK OTel "genérico", passando só a env var oficial sem definir `url` manualmente, aceita a base sem path — `http://localhost:4318` / `http://otel-collector:4318` — e completa o path sozinho.)

Depois de exportado, o trace fica consultável no [Grafana](grafana.md), via datasource do [Tempo](tempo.md).
