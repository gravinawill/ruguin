# Task 4: OTel Collector

**Depende de:** Task 3 (exporta traces pro Tempo)
**Próximas tasks que dependem desta:** 5 (Prometheus faz scrape do Collector), 9 (nenhuma direta, mas completa o trio de datasources)

## Contexto

O OTel Collector é o ponto de entrada único de telemetria de aplicações: recebe OTLP (métricas + traces) das apps via gRPC (`:4317`) ou HTTP (`:4318`), e distribui — métricas ficam expostas num endpoint que o Prometheus faz scrape (pull), traces são exportados pro Tempo. Nenhuma app existe ainda neste monorepo (Tasks 4+ do plano de email transacional), então por enquanto o Collector só fica pronto pra receber, sem receber nada de verdade — isso é esperado e não é um problema desta task.

Usa a distribuição `contrib` da imagem oficial (`otel/opentelemetry-collector-contrib`), que inclui o exporter `prometheus` (não vem na distribuição `core`).

## Arquivos

- Criar: `infrastructure/local/observability/otel/otel-collector-config.yaml`
- Modificar: `infrastructure/local/docker-compose.observability.yml`

## Interfaces

- **Consome:** `tempo:4317` (Task 3) como destino de export de traces.
- **Produz:** `localhost:4317` (gRPC) / `localhost:4318` (HTTP) — endpoint OTLP que apps rodando no host (via `pnpm dev`, Tasks 4+ do plano de email) devem usar como exporter. Também produz `otel-collector:8888` (métricas internas do próprio Collector) e `otel-collector:8889` (métricas OTLP recebidas, reexpostas em formato Prometheus) — ambos usados pela Task 5.

## Passos

- [ ] **Passo 1: Criar a config do Collector**

Criar `infrastructure/local/observability/otel/otel-collector-config.yaml`:

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

- [ ] **Passo 2: Adicionar o serviço em `docker-compose.observability.yml`**

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

- [ ] **Passo 3: Subir e verificar**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d otel-collector
sleep 5
curl -s http://localhost:8889/metrics > /dev/null && echo "collector metrics endpoint OK"
```

Como não há nenhuma app enviando OTLP ainda, o endpoint `:8889` responde `200` mas sem métricas de aplicação — o que importa aqui é confirmar que o processo subiu e o endpoint responde, não que já tenha dado. Rodar também:
```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml logs otel-collector --tail 20
```
Esperado: sem erros, log indicando que os pipelines `metrics` e `traces` iniciaram.

- [ ] **Passo 4: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/otel/
git commit -m "feat(observability): add OTel Collector (OTLP receiver, Prometheus + Tempo exporters)"
```
