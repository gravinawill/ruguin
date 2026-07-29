# Task 2: Loki — remove o bundle antigo, liga log driver em tudo

**Depende de:** Task 1
**Próximas tasks que dependem desta:** 3 (mesmo arquivo `docker-compose.observability.yml`), 9 (Grafana consulta o Loki como datasource)

## Contexto

`infrastructure/local/docker-compose.tools.yml` hoje sobe observabilidade via `grafana/otel-lgtm`, que reserva as portas `3000`/`4317`/`4318`/`9090`/`3100`/`3200` — exatamente as portas que este plano vai reocupar peça por peça (Loki fica com a `3100` já nesta task). Por isso remover o bundle é o primeiro passo, antes de existir qualquer conflito de porta.

Esta task também liga o log driver nativo do Docker (`logging: driver: loki`) em **todos** os serviços dos três arquivos compose (`docker-compose.yml`, `docker-compose.tools.yml`, e o novo `docker-compose.observability.yml`) — logs de todo container (Postgres, Kafka, Conduktor, SonarQube, o próprio Loki, etc.) aparecem no Grafana desde o primeiro boot, sem esperar nenhuma app existir e sem Promtail.

**Pré-requisito no host:** o driver de log do Loki é um plugin de Docker, não vem instalado por padrão — sem ele, todo container com `logging: driver: loki` falha ao iniciar com erro de driver desconhecido.

## Arquivos

- Modificar: `infrastructure/local/docker-compose.tools.yml` (remove o serviço `observability` e o volume `observability_data`; adiciona âncora `x-logging` + aplica em todos os serviços)
- Modificar: `infrastructure/local/docker-compose.yml` (adiciona âncora `x-logging` + aplica em todos os serviços)
- Criar: `infrastructure/local/docker-compose.observability.yml` (novo arquivo — Loki é o primeiro serviço)
- Criar: `infrastructure/local/observability/loki/loki-config.yaml`

## Interfaces

- **Produz:** Loki em `localhost:3100` (API de push/query) — usado pela Task 9 (datasource do Grafana) e por todo container via log driver.
- **Produz:** âncora `x-logging: &loki-logging` — cada arquivo compose declara a sua própria (âncoras YAML não atravessam arquivos num `docker compose -f a -f b`), mas todas apontam pro mesmo `http://localhost:3100/loki/api/v1/push` (o driver roda no host, no daemon do Docker, não dentro da rede do compose — por isso é `localhost`, não `loki:3100`).

## Passos

- [ ] **Passo 1: Instalar o plugin de log do Loki no host**

```bash
docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
```
Esperado: prompt de permissões (aceitar) e, ao final, `docker plugin ls` mostra `loki` com `ENABLED: true`.

- [ ] **Passo 2: Remover o bundle `grafana/otel-lgtm`**

Editar `infrastructure/local/docker-compose.tools.yml`, removendo inteiramente o serviço `observability` (imagem `grafana/otel-lgtm:latest`) e a entrada `observability_data:` do bloco `volumes:` no final do arquivo.

- [ ] **Passo 3: Criar a config do Loki**

Criar `infrastructure/local/observability/loki/loki-config.yaml`:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: info

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

query_range:
  results_cache:
    cache:
      embedded_cache:
        enabled: true
        max_size_mb: 100

schema_config:
  configs:
    - from: 2024-04-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  allow_structured_metadata: true
```

- [ ] **Passo 4: Criar `docker-compose.observability.yml` com o serviço Loki**

Criar `infrastructure/local/docker-compose.observability.yml`:

```yaml
name: ruguin

x-logging: &loki-logging
  driver: loki
  options:
    loki-url: 'http://localhost:3100/loki/api/v1/push'
    loki-external-labels: 'compose_service={{.Name}}'
    loki-retries: '5'
    loki-batch-size: '400'

services:
  loki:
    image: grafana/loki:latest
    restart: unless-stopped
    ports:
      - '3100:3100'
    volumes:
      - ./observability/loki/loki-config.yaml:/etc/loki/local-config.yaml:ro
      - loki_data:/loki
    command: -config.file=/etc/loki/local-config.yaml
    logging: *loki-logging

volumes:
  loki_data:
```

- [ ] **Passo 5: Ligar o log driver nos serviços existentes**

Em `infrastructure/local/docker-compose.yml`, adicionar logo após o `name: ruguin`:

```yaml
x-logging: &loki-logging
  driver: loki
  options:
    loki-url: 'http://localhost:3100/loki/api/v1/push'
    loki-external-labels: 'compose_service={{.Name}}'
    loki-retries: '5'
    loki-batch-size: '400'
```

E em **cada** serviço (`postgres`, `redis`, `kafka`, `localstack`), adicionar a linha `logging: *loki-logging`. Exemplo pro `postgres`:

```yaml
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    command: [...]
    environment: [...]
    ports: [...]
    volumes: [...]
    healthcheck: [...]
    logging: *loki-logging
```

Repetir o mesmo padrão (âncora no topo do arquivo + `logging: *loki-logging` em cada serviço) em `infrastructure/local/docker-compose.tools.yml` (`conduktor`, `sonarqube`, `adminer`, `k6`).

- [ ] **Passo 6: Subir tudo e verificar que logs chegam no Loki**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml up -d
sleep 15
curl -G -s 'http://localhost:3100/loki/api/v1/query_range' --data-urlencode 'query={compose_service="postgres"}' | grep -o '"status":"success"'
```
Esperado: `docker plugin ls` já validado no Passo 1; o `curl` imprime `"status":"success"` (o corpo completo tem as linhas de log do container `postgres` dentro de `data.result`).

- [ ] **Passo 7: Commit**

```bash
git add infrastructure/local/docker-compose.yml infrastructure/local/docker-compose.tools.yml infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/loki/
git commit -m "feat(observability): add Loki, remove otel-lgtm bundle, wire Docker log driver everywhere"
```
