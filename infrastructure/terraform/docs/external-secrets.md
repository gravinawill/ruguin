# External Secrets Operator

Sincroniza secrets do AWS Secrets Manager para dentro do cluster como `Secret`s Kubernetes nativos. Definido em `infrastructure/terraform/external-secrets.tf`.

## Para que serve

O core-server consome `DATABASE_URL`, `CACHE_MASTER_URL`, `DOCS_PASSWORD` e `OTEL_EXPORTER_OTLP_HEADERS` via `envFrom.secretRef` (ver `infrastructure/k8s/core-server/base/deployment.yaml`) — esses valores nunca são digitados diretamente no Kubernetes; o External Secrets Operator (ESO) é quem os busca no Secrets Manager e materializa como `Secret` no namespace certo, com refresh automático.

## Como funciona

- Namespace `external-secrets` + Helm chart `external-secrets` (`charts.external-secrets.io`, versão `2.5.0`), com `installCRDs: true`.
- Autentica na AWS via IRSA (`module.external_secrets_irsa`), com permissão só de leitura (`secretsmanager:GetSecretValue`, `secretsmanager:DescribeSecret`) sobre os secrets específicos que ele precisa — não um acesso amplo ao Secrets Manager.
- Um `ClusterSecretStore` (`aws-secrets-manager`) aponta para o Secrets Manager da região configurada.
- Quatro `ExternalSecret`s por ambiente (`core_server_secrets`/`ghcr_pull` para produção, `core_server_dev_secrets`/`core_server_dev_ghcr_pull` para development), todos com `refreshInterval: 1h`, lendo de 4 containers do Secrets Manager:
  - `master_user_secret` do [RDS](rds-postgres.md) (senha do Postgres, gerenciada pela própria AWS).
  - `ruguin/production/docs-password`
  - `ruguin/production/honeycomb-api-key`
  - `ruguin/production/ghcr-token`
  - `ruguin/production/valkey-auth-token` (AUTH token do [ElastiCache](elasticache-valkey.md))

## Como usar

### Populando os secrets (obrigatório antes do primeiro sync)

O Terraform só cria os **containers** de 3 dos 4 secrets, sem escrever o valor — um operador precisa rodar isto uma vez por secret:

```bash
aws secretsmanager put-secret-value --secret-id <nome> --secret-string "<valor>"
```

Os 3 nomes (também disponíveis via `terraform output`): `ruguin/production/docs-password`, `ruguin/production/honeycomb-api-key`, `ruguin/production/ghcr-token`. Até isso rodar, o `ExternalSecret` correspondente fica em `SecretSyncedError` — esperado, não um bug.

**O 4º container é diferente:** `ruguin/production/valkey-auth-token` **nunca** deve ser populado manualmente — o Terraform já escreve o valor (`random_password.valkey_auth_token`) diretamente via `aws_secretsmanager_secret_version`. Sobrescrever manualmente dessincroniza esse container do AUTH token de fato configurado no ElastiCache, causando `WRONGPASS` em todos os pods no próximo refresh do ESO.

### Migração em cluster já vivo (two-step apply)

Se os antigos `kubernetes_secret` (`core_server_secrets`, `ghcr_pull`, de uma versão anterior) já estiverem aplicados num cluster real, aplique a remoção deles **e** a criação do `ClusterSecretStore`/`ExternalSecret`s em dois `terraform apply` **separados** — nunca um só. Primeiro aplique só a remoção, confirme via `kubectl get secret` que os `Secret`s antigos sumiram, só então aplique os novos recursos. Aplicar os dois juntos faz o destroy do recurso antigo correr uma corrida contra o create do novo `ExternalSecret` para o mesmo nome/namespace.

### Verificando

```bash
kubectl -n core-server get externalsecret core-server-secrets
kubectl -n core-server get secret core-server-secrets -o yaml
```

**Gap conhecido:** a AWS rotaciona a senha master gerenciada do RDS a cada 7 dias por padrão, mas os pods do core-server consomem `DATABASE_URL` via `envFrom.secretRef` — env var lida uma vez no start do pod, nunca recarregada a quente. Um pod rodando continua usando a senha antiga após cada rotação até ser reiniciado manualmente. Rastreado como risco conhecido, não fechado ainda (precisa de um reloader controller ou trocar `envFrom` por leitura em runtime).
