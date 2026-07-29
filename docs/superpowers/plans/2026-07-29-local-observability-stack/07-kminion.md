# Task 7: kminion (métricas do Kafka)

**Depende de:** Task 5 (Prometheus já referencia este alvo)
**Próximas tasks que dependem desta:** 10 (dashboards do Kafka), 11 (alert de consumer lag)

## Contexto

kminion fala o protocolo do Kafka diretamente (usa o listener `INTERNAL` do Kafka, o mesmo que o Conduktor usa — ver `infrastructure/local/docker-compose.yml`) e expõe métricas prontas de lag de consumer group e throughput por tópico, sem exigir configuração de JMX exporter.

## Arquivos

- Criar: `infrastructure/local/observability/kminion/kminion-config.yaml`
- Modificar: `infrastructure/local/docker-compose.observability.yml`

## Interfaces

- **Consome:** `kafka:29092` (listener `INTERNAL` do Kafka, `infrastructure/local/docker-compose.yml`).
- **Produz:** `kminion:8080/metrics` — alvo já configurado no `prometheus.yml` da Task 5 sob o job `kafka`; usado pelas Tasks 10 (dashboards) e 11 (alert de lag).

## Passos

- [ ] **Passo 1: Criar a config do kminion**

Criar `infrastructure/local/observability/kminion/kminion-config.yaml`:

```yaml
kafka:
  brokers:
    - 'kafka:29092'

minion:
  consumer-groups:
    enabled: true
    scrape-interval: 30s
  topics:
    enabled: true
    scrape-interval: 30s
    info-metric:
      enabled: true
```

- [ ] **Passo 2: Adicionar o serviço em `docker-compose.observability.yml`**

```yaml
  kminion:
    image: redpandadata/kminion:latest
    restart: unless-stopped
    command: ['-config.filepath=/etc/kminion/config.yaml']
    volumes:
      - ./observability/kminion/kminion-config.yaml:/etc/kminion/config.yaml:ro
    depends_on:
      kafka:
        condition: service_healthy
    logging: *loki-logging
```

- [ ] **Passo 3: Subir e verificar**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d kminion
sleep 10
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"kafka".\{0,20\}"health":"up"'
```
Esperado: aparece o job `kafka` com `"health":"up"`.

- [ ] **Passo 4: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/kminion/
git commit -m "feat(observability): add kminion for Kafka metrics"
```
