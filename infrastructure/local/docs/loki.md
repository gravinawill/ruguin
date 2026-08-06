# Loki

Agregador de logs da Grafana. Roda como o service `loki` em `docker-compose.observability.yml`.

## Para que serve

Recebe e indexa os logs de **todos** os containers das três compose files (runtime, tools e observability) e os deixa consultáveis pelo [Grafana](grafana.md) — é o "L" da stack LGTM (Loki/Grafana/Tempo/Metrics) usada aqui.

## Como funciona

- Imagem `grafana/loki:latest`.
- Todo container do stack (runtime + tools + observability) já vem configurado com o log driver `loki` (âncora YAML `x-logging: &loki-logging`, definida em cada um dos três `docker-compose*.yml`), apontando para `http://localhost:3100/loki/api/v1/push`.
- O próprio Loki também envia seus logs para si mesmo — intencional, não descuido.
- Config em `observability/loki/loki-config.yaml`, montada read-only.
- Dados persistidos no volume `loki_data`.
- Porta `3100`.

## Como usar

```bash
pnpm infra:observability:up    # sobe runtime + observabilidade, incluindo o loki
```

- Endpoint: `localhost:3100` — normalmente você **não** acessa direto; consulta os logs pelo [Grafana](grafana.md) (datasource já provisionado automaticamente).

### Atenção

Se você subir só `pnpm infra:up` ou `pnpm infra:tools:up` (sem a stack de observabilidade), os containers continuam funcionando normalmente — o driver de log só fica tentando (e falhando) enviar logs a um Loki que não existe, com retry automático (`loki-retries: '5'`) e sem travar nada. Não é um erro para se preocupar, só logs que não chegam a lugar nenhum. Para os logs chegarem de fato, suba `pnpm infra:observability:up` ou `pnpm infra:all:up`.

**Setup obrigatório no host:** o plugin do log driver precisa estar instalado antes de qualquer `docker compose up` (das três compose files) funcionar:

```bash
docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
```
