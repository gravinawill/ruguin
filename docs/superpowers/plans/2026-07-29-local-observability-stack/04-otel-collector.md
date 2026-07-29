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
    # collector-contrib:latest usa o schema de telemetria v0.3.0, que removeu a chave
    # plana `address` (fica ignorada em silêncio) a favor de uma lista readers/pull/exporter.
    # Mesma intenção original: expor as métricas internas do próprio Collector em :8888.
    metrics:
      readers:
        - pull:
            exporter:
              prometheus:
                host: 0.0.0.0
                port: 8888
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

> **Nota sobre schema instável:** `otel/opentelemetry-collector-contrib:latest` muda rápido — o formato de `service.telemetry.metrics` acima é o que o schema atual espera. Se uma execução futura desta task bater num erro de parsing contra uma imagem ainda mais nova, não apague a seção que falhar em silêncio (foi o que aconteceu com o Tempo na Task 3 e custou uma rodada de fix) — ache a sintaxe atual/renomeada que preserva a mesma intenção (métricas do próprio Collector expostas em `:8888`) e documente a mudança com um comentário, como acima.

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
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml exec -T otel-collector wget -qO- http://localhost:8889/metrics > /dev/null && echo "collector metrics endpoint OK"
```

`:8888`/`:8889` são só de rede interna do compose (bate com a seção Interfaces desta task e com a restrição global de que exporters puros não são publicados no host) — por isso a verificação roda de dentro do próprio container (`exec ... wget`), não `curl localhost:8889` do host, que falharia por conexão recusada (a porta nunca foi publicada). Como não há nenhuma app enviando OTLP ainda, o endpoint responde mas sem métricas de aplicação — o que importa aqui é confirmar que o processo subiu e o endpoint responde, não que já tenha dado. A Task 5 (Prometheus) faz scrape dessas mesmas duas portas pelo nome do serviço (`otel-collector:8888`/`:8889`), que funciona pela rede do compose independente de publicação no host. Rodar também:
```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml logs otel-collector --tail 20
```
Esperado: sem erros, log indicando que os pipelines `metrics` e `traces` iniciaram.

- [ ] **Passo 4: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/otel/
git commit -m "feat(observability): add OTel Collector (OTLP receiver, Prometheus + Tempo exporters)"
```
