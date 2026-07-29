# Task 3: Tempo (traces)

**Depende de:** Task 2 (mesmo arquivo `docker-compose.observability.yml`, mesma âncora `x-logging`)
**Próximas tasks que dependem desta:** 4 (o OTel Collector exporta traces pro Tempo), 9 (Grafana consulta o Tempo como datasource)

## Contexto

Tempo é o storage de traces. Recebe OTLP só do OTel Collector (Task 4) — por isso o listener OTLP do Tempo (`4317`/`4318`, internos ao container) **não** é publicado no host, pra não colidir com o listener OTLP do Collector, que é o único que os hosts/apps devem alcançar diretamente. Só a porta de query (`3200`, usada pelo datasource do Grafana e pra debug manual) é publicada.

## Arquivos

- Criar: `infrastructure/local/observability/tempo/tempo.yaml`
- Modificar: `infrastructure/local/docker-compose.observability.yml`

## Interfaces

- **Consome:** âncora `x-logging` já declarada em `docker-compose.observability.yml` (Task 2).
- **Produz:** Tempo alcançável em `tempo:4317` (OTLP gRPC, só dentro da rede do compose — usado pela Task 4) e em `localhost:3200` (API de query — usado pela Task 9).

## Passos

- [ ] **Passo 1: Criar a config do Tempo**

Criar `infrastructure/local/observability/tempo/tempo.yaml`:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

ingester:
  max_block_duration: 5m

compactor:
  compaction:
    block_retention: 48h

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces
    wal:
      path: /var/tempo/wal
```

- [ ] **Passo 2: Adicionar o serviço em `docker-compose.observability.yml`**

```yaml
  tempo:
    image: grafana/tempo:latest
    restart: unless-stopped
    command: ['-config.file=/etc/tempo.yaml']
    volumes:
      - ./observability/tempo/tempo.yaml:/etc/tempo.yaml:ro
      - tempo_data:/var/tempo
    ports:
      - '3200:3200'
    logging: *loki-logging
```

E adicionar `tempo_data:` ao bloco `volumes:` no final do arquivo (junto com `loki_data:` já existente).

- [ ] **Passo 3: Subir e verificar**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d tempo
sleep 5
curl -s http://localhost:3200/ready
```
Esperado: resposta `ready`.

- [ ] **Passo 4: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/tempo/
git commit -m "feat(observability): add Tempo for trace storage"
```
