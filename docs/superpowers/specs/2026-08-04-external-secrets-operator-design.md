# External Secrets Operator — tirar os secrets do Terraform state

## Contexto

`infrastructure/terraform/secrets.tf` hoje cria dois `kubernetes_secret` com valores inline
(`database_password`, `docs_password`, `honeycomb_api_key`, `ghcr_username`, `ghcr_token`) — uma
decisão deliberada e já documentada (Decisão 10 de
`docs/superpowers/specs/2026-08-03-production-eks-observability-design.md`), tomada porque nem AWS
Secrets Manager nem um External Secrets Operator existiam como infraestrutura ainda para o primeiro
deploy. Essa wave implementa o que aquela decisão adiou: os valores saem do Terraform state de
verdade, não só trocam de nome de recurso.

Esta é a primeira de quatro sub-waves de segurança adiadas (as outras três — TLS no NLB, Valkey em
trânsito, tags de release imutáveis — ficam para specs próprias, decompostas durante o brainstorming
por serem subsistemas independentes). Esta foi escolhida para vir primeiro porque o AUTH token do
Valkey (próxima sub-wave) já nasce usando o mecanismo certo em vez de virar outro
`kubernetes_secret` inline que teria que ser migrado de novo depois.

## Decisões

### 1. Escopo: só o que é genuinamente segredo

Migram para o AWS Secrets Manager: `database_password`, `docs_password`, `honeycomb_api_key`,
`ghcr_token`. `ghcr_username` continua uma variável Terraform comum — é o dono do token, não um
segredo em si, e tratá-lo como um não adiciona proteção real.

### 2. Terraform cria o container, nunca o valor

Cada segredo vira um `aws_secretsmanager_secret` (só nome + tags + política de acesso via IAM,
Decisão 4) criado pelo Terraform. Nenhum `aws_secretsmanager_secret_version` é gerenciado pelo
Terraform — se fosse, o valor voltaria a entrar no state, só que como um recurso diferente, sem
resolver o problema original. O valor real é escrito depois, fora do Terraform, por um operador
humano (Decisão 8).

Nomeação: `ruguin/production/<nome>` — `ruguin/production/database-password`,
`ruguin/production/docs-password`, `ruguin/production/honeycomb-api-key`,
`ruguin/production/ghcr-token`.

```hcl
resource "aws_secretsmanager_secret" "database_password" {
  name = "ruguin/production/database-password"
  tags = local.tags
}

resource "aws_secretsmanager_secret" "docs_password" {
  name = "ruguin/production/docs-password"
  tags = local.tags
}

resource "aws_secretsmanager_secret" "honeycomb_api_key" {
  name = "ruguin/production/honeycomb-api-key"
  tags = local.tags
}

resource "aws_secretsmanager_secret" "ghcr_token" {
  name = "ruguin/production/ghcr-token"
  tags = local.tags
}
```

### 3. External Secrets Operator via `helm_release`, mesmo padrão do ArgoCD

`infrastructure/terraform/argocd.tf` já instala o ArgoCD assim; um arquivo novo
`infrastructure/terraform/external-secrets.tf` segue o idêntico:

```hcl
resource "kubernetes_namespace" "external_secrets" {
  metadata {
    name = "external-secrets"
  }

  depends_on = [module.eks]
}

resource "helm_release" "external_secrets" {
  name       = "external-secrets"
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  version    = "2.5.0" # confirmar contra o chart real na implementação — ver Riscos
  namespace  = kubernetes_namespace.external_secrets.metadata[0].name

  set {
    name  = "installCRDs"
    value = "true"
  }

  depends_on = [kubernetes_namespace.external_secrets]
}
```

### 4. IRSA reaproveitando o OIDC provider existente

O módulo EKS já roda com `enable_irsa = true` e já expõe `module.eks.oidc_provider_arn`
(reutilizado hoje por `load_balancer_controller_irsa` em `eks.tf`) — o mesmo padrão, com uma
policy nova restrita à leitura dos quatro segredos acima. Esse módulo (`iam-role-for-service-accounts`,
não a variante `-eks`) na versão `~> 6.0` já está baixado localmente em
`.terraform/modules/load_balancer_controller_irsa/modules/iam-role-for-service-accounts` confirma
que o input certo para uma policy customizada é `permissions` (mapa de statements), não um
`aws_iam_policy` avulso amarrado por ARN — verificado lendo `variables.tf` do módulo real, não
assumido:

```hcl
module "external_secrets_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts"
  version = "~> 6.0"

  name = "${local.cluster_name}-external-secrets"

  permissions = {
    secrets_read = {
      sid     = "SecretsManagerRead"
      actions = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      resources = [
        aws_secretsmanager_secret.database_password.arn,
        aws_secretsmanager_secret.docs_password.arn,
        aws_secretsmanager_secret.honeycomb_api_key.arn,
        aws_secretsmanager_secret.ghcr_token.arn
      ]
    }
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["external-secrets:external-secrets"]
    }
  }

  tags = local.tags
}
```

`namespace_service_accounts = ["external-secrets:external-secrets"]` assume que o chart cria uma
ServiceAccount chamada `external-secrets` no namespace `external-secrets` (nome padrão do chart) —
confirmar o nome exato contra o chart real na implementação (mesmo cuidado da Decisão 3).

### 5. `ClusterSecretStore`, não `SecretStore`

Escopo de cluster, não de namespace — os outros serviços do produto (a arquitetura de
`core-server` já documenta que o Postgres é compartilhado por até cinco serviços futuros) vão
precisar do mesmo acesso ao Secrets Manager sem duplicar o setup por namespace:

```hcl
resource "kubectl_manifest" "cluster_secret_store" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ClusterSecretStore"
    metadata = {
      name = "aws-secrets-manager"
    }
    spec = {
      provider = {
        aws = {
          service = "SecretsManager"
          region  = var.aws_region
          auth = {
            jwt = {
              serviceAccountRef = {
                name      = "external-secrets"
                namespace = "external-secrets"
              }
            }
          }
        }
      }
    }
  })

  depends_on = [helm_release.external_secrets]
}
```

`kubectl_manifest`, não `kubernetes_manifest`: `ClusterSecretStore` é um CRD que só existe depois
do Helm instalar o operador — o mesmo problema de ovo-e-galinha documentado em `versions.tf` para
o CRD `Application` do ArgoCD, resolvido do mesmo jeito.

### 6. `ExternalSecret` substitui os `kubernetes_secret` de `secrets.tf`

Os dois recursos `kubernetes_secret` saem inteiros de `secrets.tf`. Em seu lugar, dois
`kubectl_manifest` com `ExternalSecret` — mantendo o **mesmo nome** de Secret k8s resultante
(`core-server-secrets`, `ghcr-pull-secret`), então nada em `deployment.yaml` muda.

`DATABASE_URL` continua composta, mas agora via template do ESO (o Terraform não conhece mais a
senha):

```hcl
resource "kubectl_manifest" "core_server_secrets" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "core-server-secrets"
      namespace = "core-server"
    }
    spec = {
      refreshInterval = "1h"
      secretStoreRef = {
        name = "aws-secrets-manager"
        kind = "ClusterSecretStore"
      }
      target = {
        name = "core-server-secrets"
        template = {
          data = {
            DATABASE_URL = "postgresql://${var.database_username}:{{ .databasePassword }}@${aws_db_instance.core_server.address}:5432/ruguin?schema=core_server"
            DOCS_PASSWORD = "{{ .docsPassword }}"
            OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team={{ .honeycombApiKey }}"
          }
        }
      }
      data = [
        { secretKey = "databasePassword", remoteRef = { key = aws_secretsmanager_secret.database_password.name } },
        { secretKey = "docsPassword", remoteRef = { key = aws_secretsmanager_secret.docs_password.name } },
        { secretKey = "honeycombApiKey", remoteRef = { key = aws_secretsmanager_secret.honeycomb_api_key.name } }
      ]
    }
  })

  depends_on = [kubectl_manifest.cluster_secret_store, aws_db_instance.core_server, kubernetes_namespace.core_server]
}

resource "kubectl_manifest" "ghcr_pull" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "ghcr-pull-secret"
      namespace = "core-server"
    }
    spec = {
      refreshInterval = "1h"
      secretStoreRef = {
        name = "aws-secrets-manager"
        kind = "ClusterSecretStore"
      }
      target = {
        name = "ghcr-pull-secret"
        template = {
          type = "kubernetes.io/dockerconfigjson"
          data = {
            ".dockerconfigjson" = "{\"auths\":{\"ghcr.io\":{\"username\":\"${var.ghcr_username}\",\"password\":\"{{ .ghcrToken }}\",\"auth\":\"{{ printf \"${var.ghcr_username}:%s\" .ghcrToken | b64enc }}\"}}}"
          }
        }
      }
      data = [
        { secretKey = "ghcrToken", remoteRef = { key = aws_secretsmanager_secret.ghcr_token.name } }
      ]
    }
  })

  depends_on = [kubectl_manifest.cluster_secret_store, kubernetes_namespace.core_server]
}
```

Padrão de template (`.dockerconfigjson` combinando um valor fixo do Terraform com um valor vindo
do Secrets Manager via `{{ .ghcrToken }}`) confirmado contra a documentação oficial do ESO
(`external-secrets.io/latest/guides/common-k8s-secret-types`), não inventado.

### 7. Rollout: passo manual de operador antes do primeiro apply real

Depois do `terraform apply` que cria os quatro `aws_secretsmanager_secret` (containers vazios), um
operador roda, uma vez, para cada um:

```bash
aws secretsmanager put-secret-value \
  --secret-id ruguin/production/database-password \
  --secret-string "<valor real>"
```

Até isso acontecer, o `ExternalSecret` correspondente fica em `SecretSyncedError` — comportamento
esperado, não um bug do Terraform nem do ESO. A implementação documenta esse passo no runbook do
módulo (mesmo lugar onde `versions.tf` já documenta o runbook do backend S3).

### 8. `secrets.tf` desaparece, conteúdo se espalha

O arquivo `secrets.tf` inteiro é removido — os dois recursos que ele tinha (`kubernetes_secret.
core_server_secrets`, `kubernetes_secret.ghcr_pull`) não existem mais nessa forma. O novo arquivo
`external-secrets.tf` concentra tudo desta wave: o namespace, o Helm release, a IRSA role, o
`ClusterSecretStore` e os dois `ExternalSecret`.

## Riscos

- **Versão exata do chart `external-secrets` não confirmada contra o repositório real** — não
  havia `helm` CLI disponível neste ambiente para consultar `helm search repo` durante o
  brainstorming; a pesquisa web indica `2.4.0`–`2.5.0` como as versões recentes, mas a
  implementação precisa confirmar a versão real (e o nome exato da ServiceAccount que o chart
  cria) antes de fixar `helm_release.version`.
- **EKS Fargate**: este cluster roda em Fargate (`fargate_profiles`), não em nós EC2 gerenciados —
  a documentação oficial do ESO tem uma seção dedicada a Fargate + IRSA
  (`external-secrets.io/latest/eso-blogs`) porque a projeção de token da ServiceAccount tem
  particularidades nesse modo; a implementação precisa ler essa seção antes de assumir que o
  padrão "EC2 normal" funciona sem ajuste.
- **Rollout depende de um humano rodar `put-secret-value` fora do Terraform** — se isso não
  acontecer, o `ExternalSecret` fica em erro de sync indefinidamente; não há automação nem alerta
  configurado para isso nesta wave (fora de escopo — o operador acompanha o `kubectl get
  externalsecret` manualmente no primeiro rollout).
- **Migração do estado atual — race entre destroy e create no mesmo nome de Secret**: os
  `kubernetes_secret.core_server_secrets`/`ghcr_pull` de hoje e os `ExternalSecret` novos não têm
  o mesmo endereço no state (tipos de recurso diferentes), então o Terraform não bloqueia por
  endereço duplicado — mas ambos apontam para um k8s Secret com o **mesmo nome**
  (`core-server-secrets`, `ghcr-pull-secret`). Um único `apply` que destrói os antigos e cria os
  `kubectl_manifest`/`ExternalSecret` novos ao mesmo tempo arrisca uma corrida real: o ESO tenta
  criar o Secret (`creationPolicy: Owner`, o padrão) enquanto o Terraform ainda está destruindo o
  Secret homônimo que ele mesmo gerenciava. A implementação aplica em duas etapas — primeiro um
  `apply` que só remove `secrets.tf` (destrói os dois `kubernetes_secret`, confirma que sumiram do
  cluster), depois um segundo `apply` que cria tudo de `external-secrets.tf` — em vez de confiar
  num único `apply` combinado para resolver a ordem sozinho.
- **Template do `.dockerconfigjson`** usa `printf` do Go template dentro de uma string Terraform
  já interpolada (`${var.ghcr_username}`) — a mistura de interpolação Terraform com sintaxe de
  template Go dentro do mesmo `yamlencode(...)` é frágil visualmente; a implementação precisa
  testar o YAML gerado de verdade (`terraform console` ou um `local_file` de debug) antes de
  aplicar, para confirmar que o Terraform não tenta interpolar o que é sintaxe do Go template.

## Resultado

_(preenchido depois da implementação)_
