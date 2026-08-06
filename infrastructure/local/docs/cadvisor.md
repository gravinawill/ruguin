# cAdvisor

Exporter de métricas por container para o Prometheus. Roda como o service `cadvisor` em `docker-compose.observability.yml`.

## Para que serve

Expõe uso de recursos (CPU, memória, I/O de disco/rede) de **cada container** individualmente para o [Prometheus](prometheus.md), alimentando o dashboard "Docker Monitoring" no [Grafana](grafana.md). Complementa o [node-exporter](node-exporter.md), que mede a máquina host como um todo — cAdvisor é o "por container".

## Como funciona

- Imagem `gcr.io/cadvisor/cadvisor:latest`.
- Roda `privileged: true` e monta `/`, `/var/run`, `/sys` e `/var/lib/docker` do host como read-only — precisa desse nível de acesso para enxergar os cgroups de todos os containers rodando na máquina.
- Sem porta exposta ao host — só o Prometheus, dentro da rede do compose, faz scrape dele.

## Como usar

```bash
pnpm infra:observability:up    # sobe runtime + observabilidade, incluindo o cadvisor
```

Não há UI própria — as métricas aparecem no dashboard "Docker Monitoring" do [Grafana](grafana.md).
