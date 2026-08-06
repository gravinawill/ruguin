# Namespaces e ConfigMap do core-server

Namespaces e configuração não-sensível do core-server. Definidos em `infrastructure/terraform/argocd.tf` (namespaces) e `infrastructure/terraform/configmap.tf` (ConfigMaps).

## Para que serve

Provisiona o espaço de nomes de cada ambiente do core-server e a configuração que não é secreta (ao contrário de `DATABASE_URL`/`CACHE_MASTER_URL`, que vêm do [External Secrets Operator](external-secrets.md)) — variáveis como `ENVIRONMENT`, `PORT`, `CACHE_PREFIX`.

## Como funciona

- Dois namespaces (`kubernetes_namespace`, em `argocd.tf`): `core-server` (produção) e `core-server-dev` (development). Ficam fora do `default` de propósito, para que RBAC/NetworkPolicy/quota possam ser aplicados por ambiente sem afetar o resto do cluster. Criados pelo Terraform, não pelo ArgoCD (`syncOptions: [CreateNamespace=false]` nas `Application`s — ver [argocd.md](argocd.md)).
- Dois `kubernetes_config_map`, um por namespace, ambos nomeados `core-server-config` (mesmo nome, namespaces diferentes):
  - **Produção**: `ENVIRONMENT=production`, `CACHE_PREFIX=ruguin:production`.
  - **Development**: `ENVIRONMENT=develop`, `CACHE_PREFIX=ruguin:development`.
- Os dois compartilham a mesma instância de [RDS](rds-postgres.md) e [ElastiCache](elasticache-valkey.md) — o `CACHE_PREFIX` diferente é o que evita colisão de chaves entre os dois ambientes no mesmo Valkey (o isolamento do Postgres vem do `schema` na connection string, não daqui).
- `CACHE_DRIVER=valkey` e `OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces` são iguais nos dois ambientes.
- `DOCS_USERNAME` vem de `var.docs_username` (Basic Auth do endpoint `/docs`).
- Consumido pelo Deployment do core-server via `envFrom.configMapRef` (`infrastructure/k8s/core-server/base/deployment.yaml`) — ver [core-server-kustomize.md](../../k8s/docs/core-server-kustomize.md).

## Como usar

```bash
kubectl -n core-server get configmap core-server-config -o yaml
kubectl -n core-server-dev get configmap core-server-config -o yaml
```

Para mudar um valor não-sensível (ex.: `CACHE_PREFIX`), edite `configmap.tf` e rode `terraform apply` — não edite o ConfigMap direto no cluster, o Terraform reverteria na próxima aplicação.
