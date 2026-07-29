# Task 11: Alerts provisionados (2 exemplos)

**Depende de:** Task 9 (datasource `uid: prometheus`), Task 6 (`postgres_exporter`, métrica usada pelo segundo alert), Task 7 (kminion, métrica usada pelo primeiro alert)
**Próximas tasks que dependem desta:** nenhuma

## Contexto

Dois alerts de exemplo, provisionados como código no Alerting nativo do Grafana — documentam o padrão (regra + condição + threshold), não uma central de alertas operacional: não há canal de notificação configurado (email/Slack/PagerDuty), então os alerts disparam e ficam visíveis na UI do Grafana, mas ninguém é notificado. Configurar um canal de notificação real fica para quando fizer sentido (ver "Decisões em aberto" da spec).

## Arquivos

- Criar: `infrastructure/local/observability/grafana/provisioning/alerting/rules.yaml`

## Interfaces

- **Consome:** datasource `uid: prometheus` (Task 9); métrica `kminion_kafka_consumer_group_topic_lag` (kminion, Task 7); métricas `pg_stat_activity_count` e `pg_settings_max_connections` (`postgres_exporter`, Task 6, nomes padrão do exporter).

## Passos

- [ ] **Passo 1: Criar as regras de alerting**

Criar `infrastructure/local/observability/grafana/provisioning/alerting/rules.yaml`:

```yaml
apiVersion: 1

groups:
  - orgId: 1
    name: infra-alerts
    folder: Infra
    interval: 1m
    rules:
      - uid: kafka-consumer-lag-high
        title: Kafka consumer lag alto
        condition: C
        data:
          - refId: A
            relativeTimeRange:
              from: 600
              to: 0
            datasourceUid: prometheus
            model:
              expr: max(kminion_kafka_consumer_group_topic_lag) by (group_id)
              instant: true
              refId: A
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expr: ''
              conditions:
                - evaluator:
                    type: gt
                    params: [1000]
                  operator:
                    type: and
                  query:
                    params: [A]
              refId: C
        noDataState: NoData
        execErrState: Error
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'Consumer group {{ $labels.group_id }} está com lag acima de 1000 mensagens'

      - uid: postgres-connections-near-limit
        title: Postgres perto do limite de conexões
        condition: C
        data:
          - refId: A
            relativeTimeRange:
              from: 600
              to: 0
            datasourceUid: prometheus
            model:
              expr: sum(pg_stat_activity_count) / pg_settings_max_connections * 100
              instant: true
              refId: A
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expr: ''
              conditions:
                - evaluator:
                    type: gt
                    params: [80]
                  operator:
                    type: and
                  query:
                    params: [A]
              refId: C
        noDataState: NoData
        execErrState: Error
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'Postgres usando mais de 80% das conexões disponíveis'
```

- [ ] **Passo 2: Recarregar o Grafana e verificar**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml restart grafana
sleep 10
curl -s -u admin:admin http://localhost:3000/api/v1/provisioning/alert-rules | grep -o '"title":"[^"]*"'
```
Esperado: imprime `"title":"Kafka consumer lag alto"` e `"title":"Postgres perto do limite de conexões"`. Abrir `http://localhost:3000/alerting/list` no navegador e confirmar que as duas regras aparecem com estado `Normal` (não `Pending`/`Error`) — `Error` geralmente indica que a métrica referenciada não existe ainda no Prometheus (confirmar que as Tasks 6 e 7 estão de fato `up` em `/targets`).

- [ ] **Passo 3: Commit**

```bash
git add infrastructure/local/observability/grafana/provisioning/alerting/
git commit -m "feat(observability): provision example alert rules (Kafka lag, Postgres connections)"
```
