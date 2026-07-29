# Stack de observabilidade local — Design

**Data:** 2026-07-29
**Status:** Aprovado para planejamento de implementação
**Escopo:** Observabilidade da infraestrutura local de desenvolvimento (`infrastructure/local/`). Não cobre observabilidade de produção/deploy — isso fica para quando `infrastructure/deploy/` tiver um alvo definido (ver `infrastructure/deploy/README.md`).

## Contexto e objetivo

`infrastructure/local/docker-compose.tools.yml` hoje sobe observabilidade via `grafana/otel-lgtm`, uma imagem "tudo em um" (Grafana + Prometheus + Loki + Tempo + OTel Collector num único container). Funciona, mas é uma caixa-preta: não dá para versionar scrape configs, pipelines do collector, datasources ou dashboards como código, e não expõe métricas da própria infraestrutura (Postgres, Kafka, Valkey) — só o que uma aplicação instrumentada mandasse via OTLP, e nenhuma aplicação existe ainda neste monorepo (Tasks 4+ do plano de email transacional).

O objetivo deste design é substituir o bundle por uma stack de observabilidade com componentes separados e configuráveis, que já seja útil **hoje**, antes de qualquer app existir — mostrando saúde da infra (Postgres/Kafka/Valkey/host/containers) — e que fique pronta para receber telemetria de aplicações (métricas, traces, logs via OTLP) assim que as Tasks 4+ do plano de email transacional começarem a instrumentar código.

## Fora de escopo

- Observabilidade de produção/deploy (HA, retenção longa, autenticação além do admin default do Grafana, alerting com canal de notificação real). Este design é inteiramente `local/`.
- Instrumentação das aplicações em si (`apps/api-service`, `apps/dispatch-worker`) — isso é trabalho das Tasks 4+ do plano de email transacional; este design só prepara o backend de telemetria para recebê-la.
- Um pipeline de alerting completo — os alerts provisionados aqui são exemplos documentados do padrão, não uma central de alertas operacional (sem canal de notificação configurado).

## Arquitetura

### Componentes

Novo arquivo `infrastructure/local/docker-compose.observability.yml`, separado do `docker-compose.tools.yml` (observabilidade é uma categoria própria — não faz sentido misturar com Conduktor/SonarQube/Adminer/k6).

| Serviço | Papel |
|---|---|
| Grafana | UI. Datasources, dashboards e alert rules provisionados como código (não configurados manualmente na UI) |
| Prometheus | Storage de métricas; faz scrape de todos os exporters abaixo e do OTel Collector |
| OTel Collector | Recebe OTLP (gRPC `:4317` / HTTP `:4318`) das apps quando existirem; expõe métricas próprias e das apps num endpoint que o Prometheus faz scrape; exporta traces para o Tempo |
| Tempo | Storage de traces |
| Loki | Storage de logs, alimentado pelo log driver nativo do Docker (`logging: driver: loki`) em **todos** os serviços de `docker-compose.yml` + `docker-compose.tools.yml` + `docker-compose.observability.yml` — sem Promtail, sem esperar nenhuma app existir |
| `postgres_exporter` | Métricas do Postgres, autenticado com uma role dedicada (`pg_monitor`), não com o usuário `ruguin` (que é superusuário da instância) |
| kminion | Métricas do Kafka (lag de consumer group, throughput por tópico) — fala o protocolo do Kafka direto, sem exigir configuração de JMX exporter |
| `node_exporter` | Métricas do host (CPU, memória, disco) |
| cAdvisor | Métricas de CPU/memória/disco por container |

### Config-as-code

```
infrastructure/local/observability/
  otel/otel-collector-config.yaml
  prometheus/prometheus.yml
  tempo/tempo.yml
  loki/loki-config.yml
  grafana/provisioning/datasources/datasources.yml   # Prometheus + Tempo + Loki
  grafana/provisioning/dashboards/dashboards.yml      # aponta pra pasta de dashboards abaixo
  grafana/dashboards/*.json                           # dashboards da comunidade importados (Postgres, Kafka, Node/cAdvisor)
  grafana/provisioning/alerting/rules.yml              # 2 exemplos: lag de consumer group alto, conexões Postgres perto do limite
```

### Melhorias de infra necessárias

- **`postgres` (em `docker-compose.yml`)**: habilitar a extensão `pg_stat_statements` (`shared_preload_libraries=pg_stat_statements` no comando do container) e criar, via `postgres-init/`, uma role `postgres_exporter` com a role embutida `pg_monitor` do Postgres (acesso de leitura a estatísticas, sem privilégios de superusuário). Isso também corrige, para este um exporter, o ponto de credencial compartilhada levantado no design anterior (Conduktor/SonarQube continuam usando `ruguin` por ora — está fora de escopo deste design revisitar isso).
- **Plugin de log do Docker**: `logging: driver: loki` exige o plugin `grafana/loki-docker-driver` instalado no host **antes** de subir a stack — sem ele, todo container com esse driver falha ao iniciar. Documentado no README com o comando de instalação (`docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions`) e como troubleshooting (o que fazer se o plugin não estiver instalado).

## Fluxo de dados

1. `postgres_exporter`, kminion, `node_exporter` e cAdvisor expõem métricas em endpoints HTTP próprios.
2. Prometheus faz scrape (pull) desses exporters e do endpoint de métricas do OTel Collector, em intervalo configurado em `prometheus.yml`, com retenção de 15 dias.
3. Todos os containers (core + tools + observability) mandam stdout/stderr direto pro Loki via log driver do Docker — sem etapa intermediária.
4. Quando uma app existir (Task 4+) e for instrumentada com OTel SDK, ela manda OTLP (métricas + traces) pro OTel Collector, que expõe as métricas pro Prometheus fazer scrape e exporta os traces pro Tempo.
5. Grafana consulta Prometheus (métricas + alerting), Tempo (traces) e Loki (logs) como datasources provisionados; dashboards da infra (Postgres/Kafka/Node/containers) aparecem prontos no primeiro boot, sem configuração manual.

## Tratamento de erros / troubleshooting

- Plugin de log do Loki ausente no host → containers falham ao iniciar com erro claro de driver de log desconhecido; README documenta o comando de instalação antes de `pnpm infra:observability:up`.
- `postgres_exporter` não deve nunca precisar da senha do `ruguin` — se a role `pg_monitor` não existir (ex: alguém rodou `infra:reset` sem re-rodar o init script), o exporter falha a autenticar e isso aparece como target `DOWN` no Prometheus, não como erro silencioso.
- Retenção do Prometheus (15d) e do Tempo/Loki (padrão de cada imagem) evita que os volumes cresçam indefinidamente numa máquina de desenvolvedor.

## Estratégia de testes/verificação

- Verificação manual: `pnpm infra:observability:up`, depois checar que todos os targets aparecem `UP` em `http://localhost:9090/targets` (Prometheus) e que os dashboards provisionados carregam dados reais no Grafana (`http://localhost:3000`) sem necessidade de configuração manual.
- Não há testes automatizados para infraestrutura de observabilidade neste plano — é a mesma convenção já usada para o resto de `infrastructure/local/` (verificação manual documentada, sem Testcontainers).

## Decisões em aberto para a próxima fase (não bloqueiam este design)

- Quais métricas/traces exatamente as apps (`api-service`, `dispatch-worker`) vão emitir via OTel SDK — decisão das Tasks 4+ do plano de email transacional, não deste design.
- Alerting operacional de verdade (canal de notificação, on-call) — os 2 alerts provisionados aqui são só o padrão documentado.
- Se/quando `infrastructure/deploy/` ganhar um alvo, esta stack provavelmente não é o que roda em produção como está (sem HA, sem auth real) — vai precisar de um design próprio quando chegar a hora.
