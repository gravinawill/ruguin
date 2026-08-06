# node-exporter

Exporter de métricas de host (SO) para o Prometheus. Roda como o service `node-exporter` em `docker-compose.observability.yml`.

## Para que serve

Expõe métricas da máquina host — CPU, memória, disco, rede, filesystem — para o [Prometheus](prometheus.md), alimentando o dashboard "Node Exporter Full" no [Grafana](grafana.md). Não mede o container em si, mede a máquina onde o Docker está rodando (ver [cAdvisor](cadvisor.md) para métricas por container).

## Como funciona

- Imagem `prom/node-exporter:latest`.
- Monta `/proc`, `/sys` e `/` do host como read-only dentro do container (`/host/proc`, `/host/sys`, `/rootfs`), e usa `--path.procfs`/`--path.sysfs` para ler as métricas de lá em vez do `/proc`/`/sys` do próprio container.
- `--collector.filesystem.mount-points-exclude` filtra os pontos de montagem internos do próprio Docker (`/sys`, `/proc`, `/dev`, `/host`, `/etc`) para não poluir as métricas de filesystem com montagens que não são discos reais da máquina.
- Sem porta exposta ao host — só o Prometheus, dentro da rede do compose, faz scrape dele.

## Como usar

```bash
pnpm infra:observability:up    # sobe runtime + observabilidade, incluindo o node-exporter
```

Não há UI própria — as métricas aparecem no dashboard "Node Exporter Full" do [Grafana](grafana.md).
