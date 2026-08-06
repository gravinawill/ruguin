# RedisInsight

UI oficial da Redis Ltd. para inspecionar bancos Redis/Valkey. Roda como o service `redisinsight` em `docker-compose.tools.yml`.

## Para que serve

Permite navegar chaves, rodar comandos, inspecionar TTL/memória e acompanhar métricas do [Redis (Valkey)](redis.md) local pelo navegador, sem precisar do `valkey-cli`/`redis-cli` no terminal.

## Como funciona

- Imagem `redis/redisinsight:latest` — sucessora do antigo `redislabs/redisinsight` (descontinuado), expõe a UI na porta `5540` (controlada pela env var `RI_APP_PORT` da imagem, aqui no default).
- Depende do service `redis` estar `healthy` antes de subir.
- Persiste conexões/config no volume `redisinsight_data` — as databases que você cadastrar na UI sobrevivem a um `pnpm infra:tools:down` (mas não a um `down -v`/reset do volume).
- Diferente do Conduktor/Adminer, **não vem com a conexão pré-cadastrada** — é preciso adicionar manualmente na primeira vez que abrir.

## Como usar

```bash
pnpm infra:tools:up    # sobe runtime + ferramentas, incluindo o redisinsight
```

1. Abra http://localhost:5540
2. "Add Redis database" → host `redis`, porta `6379`, sem senha (nome do service, resolvido dentro da rede do compose).
3. Para inspecionar a réplica de leitura, adicione outra conexão: host `redis-replica`, porta `6379` (a porta interna do container é sempre `6379`; `6380` é só o mapeamento externo no host — ver [redis.md](redis.md)).
