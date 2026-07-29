# Task 5: Prometheus

**Depende de:** Task 4
**Próximas tasks que dependem desta:** 6, 7, 8 (adicionam os exporters que os `scrape_configs` já referenciam), 9 (Grafana consulta o Prometheus como datasource)

## Contexto

O `prometheus.yml` desta task já declara os alvos de scrape de `postgres_exporter` (Task 6), kminion (Task 7) e `node_exporter`/cAdvisor (Task 8) — nenhum desses serviços existe ainda neste ponto do plano, então esses alvos aparecem como `DOWN` em `http://localhost:9090/targets` até as tasks correspondentes rodarem. Isso é esperado: evita reeditar `prometheus.yml` a cada task subsequente.

## Arquivos

- Criar: `infrastructure/local/observability/prometheus/prometheus.yml`
- Modificar: `infrastructure/local/docker-compose.observability.yml`

## Interfaces

- **Consome:** `otel-collector:8888`/`:8889` (Task 4).
- **Produz:** `localhost:9090` — usado pela Task 9 (datasource do Grafana) e pelas Tasks 6/7/8/11 (alvos de scrape/alerting que este `prometheus.yml` já reserva).

## Passos

- [ ] **Passo 1: Criar a config do Prometheus**

Criar `infrastructure/local/observability/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ['localhost:9090']

  - job_name: otel-collector
    static_configs:
      - targets: ['otel-collector:8888', 'otel-collector:8889']

  - job_name: postgres
    static_configs:
      - targets: ['postgres-exporter:9187']

  - job_name: kafka
    static_configs:
      - targets: ['kminion:8080']

  - job_name: node
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: cadvisor
    static_configs:
      - targets: ['cadvisor:8080']
```

- [ ] **Passo 2: Adicionar o serviço em `docker-compose.observability.yml`**

```yaml
  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=15d'
    volumes:
      - ./observability/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    ports:
      - '9090:9090'
    depends_on:
      - otel-collector
    logging: *loki-logging
```

E adicionar `prometheus_data:` ao bloco `volumes:` no final do arquivo.

- [ ] **Passo 3: Subir e verificar**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d prometheus
sleep 5
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"otel-collector"'
```
Esperado: aparece pelo menos uma vez (o job `otel-collector` existe e está sendo scrapado — `postgres`/`kafka`/`node`/`cadvisor` aparecem como `down` até as Tasks 6-8, o que é esperado).

- [ ] **Passo 4: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/prometheus/
git commit -m "feat(observability): add Prometheus, scrape configs for all planned exporters"
```
