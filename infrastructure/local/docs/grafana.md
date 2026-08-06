# Grafana

Visualização e exploração da telemetria. Roda como o service `grafana` em `docker-compose.observability.yml`.

## Para que serve

É o ponto único de entrada para dashboards, métricas, logs e traces — o "G" da stack LGTM. Junta em um só lugar o que [Prometheus](prometheus.md) (métricas), [Tempo](tempo.md) (traces) e [Loki](loki.md) (logs) coletam separadamente.

## Como funciona

- Imagem `grafana/grafana:latest`.
- Datasources (Prometheus, Tempo, Loki) e dashboards são **provisionados automaticamente** no boot, sem passo manual:
  - `observability/grafana/provisioning/datasources/datasources.yaml` — registra os 3 datasources.
  - `observability/grafana/provisioning/dashboards/dashboards.yaml` — aponta para a pasta de dashboards.
  - `observability/grafana/dashboards/*.json` — dashboards prontos: Docker Monitoring, Kminion (Cluster/Groups/Topic), Node Exporter Full, Postgres Overview.
  - `observability/grafana/provisioning/alerting/rules.yaml` — regras de alerta provisionadas.
- `GF_AUTH_ANONYMOUS_ENABLED: 'false'` — login sempre exigido, mesmo em dev.
- Depende de `prometheus`, `tempo` e `loki` estarem de pé antes de subir.
- Dados (usuários, preferências, etc.) persistidos no volume `grafana_data`.
- Porta `3000`.

## Como usar

```bash
pnpm infra:observability:up    # sobe runtime + observabilidade, incluindo o grafana
# ou
pnpm infra:all:up               # runtime + tools + observabilidade
```

- Endereço: http://localhost:3000
- Login: `admin` / `admin`
- Os dashboards já aparecem prontos no menu "Dashboards" — não precisa importar nada manualmente.
