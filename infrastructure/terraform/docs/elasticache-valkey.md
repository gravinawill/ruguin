# ElastiCache Valkey

Cache gerenciado do core-server em produção. Definido em `infrastructure/terraform/data.tf` (`aws_elasticache_replication_group.core_server`).

## Para que serve

É o cache real do core-server rodando em produção/development na AWS, via `@ruguin/cache` (driver Valkey) — o equivalente em produção dos services `redis`/`redis-replica` do [docker-compose local](../../local/docs/redis.md), que existem justamente para exercitar esse mesmo roteamento master/replica localmente.

## Como funciona

- Engine `valkey` 8.0, `cache.t4g.micro`, `num_cache_clusters = 1` — um único nó (sem réplica adicional em produção agora; `automatic_failover_enabled = false`).
- Criptografia em repouso (chave KMS gerenciada pela AWS) **e** em trânsito (TLS) habilitadas — diferente do dev local, que não tem nem senha.
- **AUTH token obrigatório**: `random_password.valkey_auth_token` gera um token de 32 caracteres, restrito ao charset `!$-` (não o range completo `!&#$^<>-` que a AWS permite para tokens do ElastiCache). Motivo do charset restrito: `#` é delimitador de fragment de URL, `&`/`<`/`>` têm significado especial em contextos de URL/HTML, e `^` é percent-encoded pelo parser `URL` do Node — sobreviveria como caractere original só porque o `parseURL()` do client `iovalkey` faz `decodeURIComponent()` no resultado, uma particularidade desse client específico, não uma garantia geral de que `^` é seguro em URL.
- O token é escrito no Secrets Manager pelo próprio Terraform (`ruguin/production/valkey-auth-token`, ver [external-secrets.md](external-secrets.md)) — **nunca** deve ser populado manualmente via `put-secret-value`, ou desincroniza do token real configurado neste replication group.
- `auth_token_update_strategy = "SET"` (não `ROTATE`): correto para o primeiro deploy, sem tráfego ainda num replication group sem senha. Se este token for rotacionado depois de já estar servindo tráfego real, trocar para `ROTATE` primeiro — é o que mantém o token antigo válido durante a janela entre o ESO pegar o novo valor e um `kubectl rollout restart` do Deployment do core-server (mesma limitação de `envFrom.secretRef` sem hot-reload do [RDS](rds-postgres.md)).
- Acesso de rede restrito: o security group `aws_security_group.elasticache` só libera a porta 6379 a partir do security group do cluster [EKS](eks.md).

## Como usar

```bash
terraform output cache_endpoint    # endpoint primário do replication group
```

A connection string real (`CACHE_MASTER_URL`, formato `rediss://:<token>@<endpoint>:6379` — note o `rediss` com TLS) não é lida daqui diretamente — é montada e entregue ao core-server pelo [External Secrets Operator](external-secrets.md).
