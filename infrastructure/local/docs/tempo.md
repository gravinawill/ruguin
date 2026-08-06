# Tempo

Backend de distributed tracing da Grafana. Roda como o service `tempo` em `docker-compose.observability.yml`.

## Para que serve

Armazena os traces distribuídos exportados pelas aplicações (via OpenTelemetry) e os deixa consultáveis pelo [Grafana](grafana.md) — é o "T" da stack LGTM. Permite acompanhar uma requisição ponta a ponta através de múltiplos serviços.

## Como funciona

- Imagem `grafana/tempo:latest`.
- Não recebe traces diretamente das aplicações — quem recebe é o [OTel Collector](otel-collector.md), que encaminha para o Tempo.
- Config em `observability/tempo/tempo.yaml`, montada read-only.
- Dados persistidos no volume `tempo_data`.
- Porta `3200` (API de consulta).

## Como usar

```bash
pnpm infra:observability:up    # sobe runtime + observabilidade, incluindo o tempo
```

- Endpoint: `localhost:3200` — normalmente você **não** acessa direto; explora traces pelo [Grafana](grafana.md) (datasource já provisionado automaticamente).
- Para uma app enviar traces, aponte o exporter OpenTelemetry dela para o [OTel Collector](otel-collector.md), não para o Tempo diretamente.
