# Redis (Valkey)

Cache do produto. Roda como dois services em `docker-compose.yml`: `redis` (master) e `redis-replica` (réplica de leitura).

## Para que serve

É o cache consumido pelo `@ruguin/cache` (driver Valkey). A réplica existe só para que o roteamento master/replica desse pacote — que em produção aponta para o primary/replica de um ElastiCache real (ver `infrastructure/terraform/docs/elasticache-valkey.md`) — possa ser exercitado localmente também, e não só em produção.

## Como funciona

- Imagem `valkey/valkey:9-alpine` nos dois services. Valkey é um fork open-source do Redis, compatível com o protocolo RESP e com os comandos que os clients Redis já usam — por isso o compose (e a documentação) ainda chama a categoria de "Redis".
- `redis` (master): porta `6379`, dados persistidos no volume `valkey_data`.
- `redis-replica`: sobe com `command: ['valkey-server', '--replicaof', 'redis', '6379']`, ou seja, replica o `redis` automaticamente assim que sobe. Não tem volume próprio — o estado dela vem sempre do master. Porta `6380`. Depende do `redis` estar `healthy` antes de subir.
- Healthcheck em ambos via `valkey-cli ping`.
- Sem senha localmente — diferente de produção, onde o ElastiCache exige AUTH token (`rediss://`, TLS).

## Como usar

```bash
pnpm infra:up          # sobe redis + redis-replica junto com o resto do runtime
```

- Master: `localhost:6379`, sem senha.
- Réplica (somente leitura): `localhost:6380`, sem senha.
- Para inspecionar via UI, suba o [RedisInsight](redisinsight.md) (`pnpm infra:tools:up`) e adicione uma conexão apontando para `redis:6379` (dentro da rede do compose) ou `localhost:6379` (do host).
- `pnpm infra:reset` apaga o volume `valkey_data` — a réplica se resincroniza do zero a partir do master na próxima subida.
