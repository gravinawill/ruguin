# Overview — Stack de observabilidade local

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para executar este plano task a task. Os passos usam checkbox (`- [ ]`) para rastreamento.

**Spec de arquitetura:** `docs/superpowers/specs/2026-07-29-local-observability-stack-design.md`

**Goal:** substituir o bundle `grafana/otel-lgtm` em `infrastructure/local/docker-compose.tools.yml` por uma stack de observabilidade com componentes separados e configuráveis como código (Grafana, Prometheus, OTel Collector, Tempo, Loki, `postgres_exporter`, kminion, `node_exporter`, cAdvisor), útil desde o primeiro boot — antes de qualquer app existir — porque expõe métricas/logs da própria infraestrutura (Postgres, Kafka, host, containers), e pronta para receber telemetria de aplicações via OTLP assim que as Tasks 4+ do plano de email transacional começarem a instrumentar código.

**Architecture:** novo arquivo `infrastructure/local/docker-compose.observability.yml`, combinável via `-f` com `docker-compose.yml` (core) e `docker-compose.tools.yml` (dev tooling). Prometheus faz scrape (pull) de todos os exporters e do OTel Collector; todos os containers de todos os três arquivos mandam log direto pro Loki via log driver nativo do Docker (sem Promtail); Grafana consulta os três (Prometheus/Tempo/Loki) como datasources provisionados como código, com dashboards e alerts também provisionados (sem clique manual na UI).

**Tech Stack:** Docker Compose, Grafana, Prometheus, OpenTelemetry Collector (distribuição `contrib`), Grafana Tempo, Grafana Loki (+ plugin `grafana/loki-docker-driver`), `prometheus-community/postgres_exporter`, kminion (Kafka), `prom/node-exporter`, `gcr.io/cadvisor/cadvisor`.

Este diretório quebra o plano acima em uma task por arquivo, cada uma autocontida (contexto, arquivos, interfaces, passos com código completo), para ser distribuída e executada individualmente.

## Ordem e dependências

| # | Task | Depende de |
|---|---|---|
| 1 | [Postgres — role de monitoramento + `pg_stat_statements`](01-postgres-monitoring-role.md) | — (assume `infrastructure/local/docker-compose.yml` já existente) |
| 2 | [Loki — remove o bundle antigo, liga log driver em tudo](02-loki-logging.md) | 1 (mesmo arquivo `docker-compose.yml`, edições sequenciais) |
| 3 | [Tempo (traces)](03-tempo.md) | 2 (mesmo arquivo `docker-compose.observability.yml`) |
| 4 | [OTel Collector](04-otel-collector.md) | 3 (exporta traces pro Tempo) |
| 5 | [Prometheus](05-prometheus.md) | 4 (faz scrape do Collector) |
| 6 | [`postgres_exporter`](06-postgres-exporter.md) | 1, 5 |
| 7 | [kminion](07-kminion.md) | 5 |
| 8 | [`node_exporter` + cAdvisor](08-node-exporter-cadvisor.md) | 5 |
| 9 | [Grafana + datasources](09-grafana-datasources.md) | 5, 4, 2 |
| 10 | [Dashboards provisionados](10-grafana-dashboards.md) | 9, 6, 7, 8 |
| 11 | [Alerts provisionados](11-grafana-alerts.md) | 9, 6, 7 |
| 12 | [Scripts, README, verificação ponta a ponta](12-scripts-readme-e2e.md) | todas as anteriores |

## Escopo e o que fica de fora

Este plano cobre só a stack de observabilidade em si (`infrastructure/local/`). **Fora de escopo:**
- Observabilidade de produção/deploy — nada aqui presume um alvo definido em `infrastructure/deploy/`.
- Instrumentação das aplicações (`apps/api-service`, `apps/dispatch-worker`) — é trabalho das Tasks 4+ do plano de email transacional; este plano só prepara o backend de telemetria para recebê-la (OTel Collector já escutando OTLP em `localhost:4317`/`:4318`).
- Alerting operacional de verdade (canal de notificação, on-call) — os 2 alerts da Task 11 são só o padrão documentado.

## Restrições globais (valem para todas as tasks)

- Todo arquivo YAML de configuração fica em `infrastructure/local/observability/<ferramenta>/`.
- Toda imagem Docker usa a tag `latest` — mesma convenção já usada pelas outras ferramentas dev-only deste repo (Conduktor, SonarQube, Adminer, k6): reprodutibilidade estrita não é o objetivo aqui, é uma dependência de desenvolvimento, não a infra core (Postgres/Valkey/Kafka/LocalStack, essas sim pinadas por versão).
- Toda âncora YAML (`x-logging`) precisa ser redeclarada em cada arquivo compose que a usa — âncoras não atravessam arquivos diferentes num `docker compose -f a -f b`, cada `-f` é um documento YAML independente.
- Nenhum serviço de observabilidade expõe porta de host além das UIs/APIs que fazem sentido debugar direto (Grafana `:3000`, Prometheus `:9090`, Tempo `:3200`, Loki `:3100`, OTel Collector `:4317`/`:4318` — este último porque apps rodando no host via `pnpm dev` precisam alcançá-lo). Exporters puros (`postgres_exporter`, kminion, `node_exporter`, cAdvisor) só são alcançáveis dentro da rede do compose, pelo nome do serviço.
- Todos os testes de verificação são manuais (curl/UI), mesma convenção já usada no resto de `infrastructure/local/` — sem testes automatizados de infraestrutura.
