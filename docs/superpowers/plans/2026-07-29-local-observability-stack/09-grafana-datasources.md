# Task 9: Grafana + datasources

**Depende de:** Task 5 (Prometheus), Task 4 (implica Tempo/Task 3 já no ar), Task 2 (Loki)
**Próximas tasks que dependem desta:** 10 (dashboards), 11 (alerts)

## Contexto

Datasources provisionados como código (arquivo YAML lido no boot), não configurados manualmente na UI — sobrevivem a `docker compose down -v` e ficam versionados no git. Os `uid`s de `Prometheus` e `Tempo` são fixados explicitamente (`prometheus`, `tempo`) para poderem ser referenciados de forma previsível pelas Tasks 10 e 11, em vez de depender de um ID gerado automaticamente.

## Arquivos

- Criar: `infrastructure/local/observability/grafana/provisioning/datasources/datasources.yaml`
- Criar: `infrastructure/local/observability/grafana/provisioning/dashboards/dashboards.yaml`
- Modificar: `infrastructure/local/docker-compose.observability.yml`

## Interfaces

- **Consome:** `prometheus:9090` (Task 5), `tempo:3200` (Task 3), `loki:3100` (Task 2).
- **Produz:** Grafana em `localhost:3000` (login `admin`/`admin`); datasource `uid: prometheus` e `uid: tempo` — referenciados pela Task 11 (alert rules). Pasta de dashboards provisionados em `/var/lib/grafana/dashboards` dentro do container — usada pela Task 10.

## Passos

- [ ] **Passo 1: Criar o provisionamento de datasources**

Criar `infrastructure/local/observability/grafana/provisioning/datasources/datasources.yaml`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    jsonData:
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo

  - name: Tempo
    uid: tempo
    type: tempo
    access: proxy
    url: http://tempo:3200

  - name: Loki
    uid: loki
    type: loki
    access: proxy
    url: http://loki:3100
```

- [ ] **Passo 2: Criar o provider de dashboards (a Task 10 preenche a pasta)**

Criar `infrastructure/local/observability/grafana/provisioning/dashboards/dashboards.yaml`:

```yaml
apiVersion: 1

providers:
  - name: 'infra'
    orgId: 1
    folder: 'Infra'
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    options:
      path: /var/lib/grafana/dashboards
```

- [ ] **Passo 3: Adicionar o serviço em `docker-compose.observability.yml`**

```yaml
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_AUTH_ANONYMOUS_ENABLED: 'false'
    ports:
      - '3000:3000'
    volumes:
      - ./observability/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./observability/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus
      - tempo
      - loki
    logging: *loki-logging
```

E adicionar `grafana_data:` ao bloco `volumes:` no final do arquivo. A pasta `./observability/grafana/dashboards` ainda não existe — a Task 10 a cria; até lá o provider fica com uma pasta vazia montada, sem erro.

- [ ] **Passo 4: Subir e verificar os datasources**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d grafana
sleep 10
curl -s -u admin:admin http://localhost:3000/api/datasources | grep -o '"name":"[A-Za-z]*"'
```
Esperado: imprime `"name":"Prometheus"`, `"name":"Tempo"` e `"name":"Loki"` — os três provisionados automaticamente, sem clique manual.

- [ ] **Passo 5: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml infrastructure/local/observability/grafana/
git commit -m "feat(observability): add Grafana with provisioned Prometheus/Tempo/Loki datasources"
```
