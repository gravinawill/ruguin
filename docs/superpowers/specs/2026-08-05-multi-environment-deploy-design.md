# Ambientes de deploy separados: production + development

## Contexto

A spec [2026-08-05-immutable-release-tags-design.md](2026-08-05-immutable-release-tags-design.md)
restringiu a promoção automática de imagem só a `master`, porque promover em `develop` e `master`
ao mesmo tempo — escrevendo os dois na mesma linha do mesmo `deployment.yaml` — garantia conflito
de merge em toda `git flow release finish`. A justificativa usada então: "quando um ambiente de
staging observando `develop` existir de verdade, essa restrição é revisitada". Esta spec é essa
revisão — o usuário confirmou, durante a implementação daquele fix, que vai ter ambientes de
production e development de verdade, não só uma branch sem ninguém observando.

Hoje existe **um** módulo Terraform inteiro (VPC, EKS, RDS, ElastiCache — parametrizado por
`var.environment`, default `"production"`) e **um** namespace de aplicação (`core-server`), com
**uma** `Application` do ArgoCD e **um** `deployment.yaml`/`service.yaml`. "Ambiente de
development" poderia significar uma segunda pilha AWS inteira (isolamento total, ~$160-180/mês
adicionais, dobrando o custo já estimado na spec de observabilidade) ou um ambiente mais leve
dentro da mesma infraestrutura — decisão já confirmada com o usuário: **infra compartilhada,
namespace separado**, pelo custo praticamente nulo e por ser suficiente pra validar o que a branch
`develop` builda antes de virar release.

## Decisões

### 1. Namespace novo, cluster/VPC/RDS/ElastiCache compartilhados

`core-server-dev` é um namespace Kubernetes novo no mesmo cluster EKS que já hospeda `core-server`,
`argocd`, `external-secrets`. Nenhum recurso AWS novo do tipo "outra pilha inteira" — a mesma VPC,
o mesmo RDS, o mesmo ElastiCache atendem os dois ambientes.

```hcl
resource "kubernetes_namespace" "core_server_dev" {
  metadata {
    name = "core-server-dev"
  }

  depends_on = [module.eks]
}
```

### 2. Isolamento de dados: schema Postgres + prefixo de cache separados, sem infraestrutura nova

Decisão já confirmada com o usuário. `core_server_dev` é um segundo schema no mesmo RDS — mesmo
mecanismo que já isola `core_server` (o schema de produção) hoje, só que por ambiente em vez de por
serviço:

```
DATABASE_URL = "postgresql://${var.database_username}:{{ .databasePassword }}@${aws_db_instance.core_server.address}:5432/ruguin?schema=core_server_dev"
```

O schema não é criado automaticamente pelo Prisma — `prisma migrate deploy` contra essa
`DATABASE_URL` cria e popula `core_server_dev` na primeira vez, do mesmo jeito que criou
`core_server` originalmente. Nenhuma migration nova: as mesmas migrations do schema de produção
rodam contra o schema de development, só que apontando pra um schema diferente.

`CACHE_PREFIX` (variável já existente em `configmap.tf`, hoje só um valor fixo) passa a diferir por
ambiente — `core-server:dev:` em vez de `core-server:` — evitando colisão de chave no mesmo
ElastiCache sem precisar de uma instância separada.

### 3. Manifests via Kustomize: `base/` + `overlays/{production,development}/`

`infrastructure/k8s/core-server/` reorganiza de dois arquivos soltos pra:

```text
infrastructure/k8s/core-server/
  base/
    deployment.yaml       # o Deployment de hoje, sem tag/digest de imagem fixado
    service.yaml          # o Service de hoje
    kustomization.yaml    # lista os dois acima
  overlays/
    production/
      kustomization.yaml  # base + namespace core-server + images: (digest fixado por release-image.yml)
    development/
      kustomization.yaml  # base + namespace core-server-dev + images: (digest fixado por release-image.yml)
      replicas-patch.yaml # 1 réplica (base já tem replicas: 2, produção herda sem patch)
```

`base/service.yaml` já é `type: LoadBalancer` hoje (é o `service.yaml` atual, movido sem alteração)
— os dois overlays herdam isso automaticamente, então development ganha seu próprio NLB (Decisão 6)
só por existir num namespace próprio, sem precisar de nenhum patch de Service. O campo `namespace:`
no topo de cada `kustomization.yaml` já reescreve o `metadata.namespace` de todos os recursos do
overlay — outro motivo pelo qual nenhum patch extra é necessário só pra trocar o namespace.

`base/deployment.yaml` perde a linha `image: ghcr.io/gravinawill/ruguin/core-server:latest`
hardcoded — Kustomize's transformer `images:` em cada `kustomization.yaml` de overlay é quem define
a imagem final, exatamente o mecanismo desenhado pra isso (não uma convenção improvisada). É
suporte nativo do `kubectl apply -k` e do próprio ArgoCD — nenhuma ferramenta nova, nenhuma
dependência adicional. Testado localmente (`kustomize build`, ferramenta standalone, não só o
subconjunto embutido no `kubectl`): um `images: [{name: ..., digest: sha256:...}]` no overlay
realmente produz `image: <name>@<digest>` no manifest final, e o `sed` da Decisão 5 realmente
atualiza esse campo em uma cópia real do arquivo.

Mesma limitação da spec anterior: nenhum digest real é obtível neste ambiente (sem `read:packages`
no token disponível). Os dois `kustomization.yaml` de overlay nascem com um digest placeholder
sintaticamente válido (`sha256:` seguido de 64 zeros) — inválido como imagem real, mas suficiente
pro padrão do `sed` já ter algo pra casar na primeira execução automática de `promote`, igual ao
que já foi resolvido na spec de tags imutáveis.

### 4. Duas `Application`s do ArgoCD, uma por ambiente

`kubectl_manifest.core_server_application` (produção) muda só o `path`, de
`infrastructure/k8s/core-server` pra `infrastructure/k8s/core-server/overlays/production`.
Uma segunda `Application` é criada:

```hcl
resource "kubectl_manifest" "core_server_dev_application" {
  yaml_body = yamlencode({
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "Application"
    metadata = {
      name      = "core-server-dev"
      namespace = kubernetes_namespace.argocd.metadata[0].name
    }
    spec = {
      project = "default"
      source = {
        repoURL        = var.argocd_repo_url
        targetRevision = "develop"
        path           = "infrastructure/k8s/core-server/overlays/development"
      }
      destination = {
        server    = "https://kubernetes.default.svc"
        namespace = "core-server-dev"
      }
      syncPolicy = {
        automated   = { prune = true, selfHeal = true }
        syncOptions = ["CreateNamespace=false"]
      }
    }
  })

  depends_on = [helm_release.argocd, kubernetes_namespace.core_server_dev]
}
```

`targetRevision = "develop"` (literal, não `HEAD`) — diferente de produção, que continua rastreando
a branch default. Isso é o que faz development seguir a branch `develop` especificamente, em vez de
qualquer que seja a branch default do repositório.

### 5. `promote` volta a rodar em `develop` — agora sem risco de conflito

A restrição a só `master`, da spec anterior, existia porque as duas branches escreviam a mesma linha
do mesmo arquivo. Com overlays separados, `develop` escreve só
`overlays/development/kustomization.yaml` e `master` só `overlays/production/kustomization.yaml` —
arquivos diferentes, sem colisão possível entre as duas branches, e sem conflito de merge quando
`git flow release finish` integra `develop` em `master` (production nunca teve um commit tocando o
arquivo de development, e vice-versa).

```yaml
  promote:
    needs: image
    if: |
      github.event_name != 'pull_request' &&
      (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/master')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Update overlay image digest
        run: |
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::refusing to promote invalid digest '$DIGEST'"; exit 1; }
          sed -i -E "s#digest: sha256:[0-9a-f]+#digest: ${DIGEST}#" \
            "infrastructure/k8s/core-server/overlays/${OVERLAY}/kustomization.yaml"
        env:
          DIGEST: ${{ needs.image.outputs.digest }}
          OVERLAY: ${{ github.ref_name == 'develop' && 'development' || 'production' }}

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git diff --quiet -- "infrastructure/k8s/core-server/overlays/${OVERLAY}" && exit 0
          git add "infrastructure/k8s/core-server/overlays/${OVERLAY}"
          git commit -m "chore(deploy): promote core-server (${OVERLAY}) to ${DIGEST}"
          for attempt in 1 2 3; do
            if git push; then exit 0; fi
            git pull --rebase origin "${GITHUB_REF_NAME}"
          done
          exit 1
        env:
          DIGEST: ${{ needs.image.outputs.digest }}
          OVERLAY: ${{ github.ref_name == 'develop' && 'development' || 'production' }}
```

O retry com `git pull --rebase` (da spec anterior) continua necessário só pro push em `master` —
`develop` não tem o `@semantic-release/git` de `release.yml` competindo pelo mesmo push (esse
workflow já é `branches: [master]` só), mas manter o retry nos dois casos é mais simples que
condicioná-lo por branch, sem custo real.

### 6. Development ganha seu próprio NLB público

Decisão já confirmada com o usuário. Como `base/service.yaml` já é `type: LoadBalancer` (Decisão
3), o overlay de development herda isso automaticamente, sem precisar de patch — um segundo NLB
nasce só por `core-server-dev` ser um namespace próprio com seu próprio Service, endereço público
separado do de produção, sem nenhum Ingress/roteamento por path (mesma escolha "L4 simples, sem
Ingress" já feita pra produção, reaplicada aqui por consistência, não uma decisão nova).

### 7. Segredos: reaproveitados, não duplicados

Os 4 segredos já geridos pelo ESO (`database_password` via RDS-managed, `docs_password`,
`honeycomb_api_key`, `ghcr_token`, `valkey_auth_token`) continuam sendo os mesmos valores — RDS e
ElastiCache são compartilhados, então não existe uma segunda senha de banco ou um segundo AUTH
token. O que muda é que `core-server-dev` precisa do seu próprio `ExternalSecret` (Secrets do
Kubernetes não cruzam namespace), montando `DATABASE_URL`/`CACHE_MASTER_URL` com o schema/prefixo
de development em vez dos de produção — reaproveitando o mesmo `ClusterSecretStore` (já
cluster-scoped, acessível de qualquer namespace sem mudança).

```hcl
resource "kubectl_manifest" "core_server_dev_secrets" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "core-server-secrets"
      namespace = kubernetes_namespace.core_server_dev.metadata[0].name
    }
    spec = {
      secretStoreRef = { name = "aws-secrets-manager", kind = "ClusterSecretStore" }
      target = {
        name = "core-server-secrets"
        template = {
          data = {
            DATABASE_URL               = "postgresql://${var.database_username}:{{ .databasePassword }}@${aws_db_instance.core_server.address}:5432/ruguin?schema=core_server_dev"
            CACHE_MASTER_URL           = "rediss://:{{ .valkeyAuthToken }}@${aws_elasticache_replication_group.core_server.primary_endpoint_address}:6379"
            DOCS_PASSWORD              = "{{ .docsPassword }}"
            OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team={{ .honeycombApiKey }}"
          }
        }
      }
      data = [
        { secretKey = "databasePassword", remoteRef = { key = aws_db_instance.core_server.master_user_secret[0].secret_arn } },
        { secretKey = "docsPassword", remoteRef = { key = aws_secretsmanager_secret.docs_password.name } },
        { secretKey = "honeycombApiKey", remoteRef = { key = aws_secretsmanager_secret.honeycomb_api_key.name } },
        { secretKey = "valkeyAuthToken", remoteRef = { key = aws_secretsmanager_secret.valkey_auth_token.name } }
      ]
    }
  })

  depends_on = [
    kubectl_manifest.cluster_secret_store, aws_db_instance.core_server,
    aws_elasticache_replication_group.core_server, aws_secretsmanager_secret_version.valkey_auth_token,
    kubernetes_namespace.core_server_dev
  ]
}
```

`CACHE_MASTER_URL` fica idêntico ao de produção (mesmo endpoint, mesmo token) — o isolamento vem só
do `CACHE_PREFIX` no ConfigMap de development, não da URL de conexão em si.

### 8. ConfigMap e Fargate profile de development

`infrastructure/terraform/configmap.tf` ganha um segundo `kubernetes_config_map` (
`core-server-dev-config`), igual ao de produção exceto `ENVIRONMENT = "development"` e
`CACHE_PREFIX = "core-server:dev:"`. `eks.tf` ganha uma entrada em `fargate_profiles` pro namespace
`core-server-dev`, seguindo o mesmo padrão já usado pra `kube_system`/`core_server`/`argocd`/
`external_secrets`.

### 9. Sizing: 1 réplica em development, 2 em produção

Sem justificativa pra rodar em alta disponibilidade um ambiente que existe só pra validar builds
antes de virar release — `overlays/development/replicas-patch.yaml` fixa `replicas: 1`, reduzindo o
custo incremental de Fargate deste ambiente pela metade em relação a rodar os mesmos 2 réplicas de
produção.

## Riscos

- **Nenhuma aplicação real testada.** Mesmo limite de sempre neste ambiente — sem cluster/ArgoCD de
  verdade, a verificação fica limitada a `kubeconform`/`kustomize build` local e revisão de
  consistência. A confirmação de que os dois overlays realmente produzem manifests válidos (e que o
  ArgoCD realmente sincroniza os dois independentemente) só acontece no primeiro `apply` real.
- **RDS/ElastiCache compartilhados são um ponto único de falha entre os dois ambientes** — uma
  instância sobrecarregada por tráfego de development afeta produção, e vice-versa. Aceito
  conscientemente pelo custo (ver Contexto); se o tráfego de qualquer um dos dois crescer a ponto de
  interferir no outro, separar as instâncias vira a próxima decisão a revisitar, não algo a
  antecipar sem sinal real de que é necessário.
- **O compartilhamento é blast radius de credencial, não só de disponibilidade.**
  `DATABASE_URL` de development usa o mesmo usuário master do RDS que produção — o `?schema=`
  só define o `search_path` da conexão, a role continua com acesso irrestrito de leitura e
  escrita a QUALQUER schema, incluindo `core_server` de produção. `CACHE_MASTER_URL` é idêntico
  byte a byte ao de produção (mesmo endpoint, mesmo AUTH token); só o `CACHE_PREFIX` no ConfigMap
  separa as chaves por convenção de aplicação, não por permissão. Um bug ou comando manual
  disparado contra development (`FLUSHALL`, uma migration mal escrita) pode atingir dados de
  produção diretamente. Mitigação real (role Postgres dedicada com `GRANT` restrito a
  `core_server_dev`) fica fora do escopo desta wave — registrado aqui para não ser esquecido, não
  porque o risco seja aceitável indefinidamente.
- **`develop` passa a receber commits de bot** (o job `promote`, junto com quem já empurra
  código de verdade nessa branch) — o retry do CI protege o push do próprio CI, mas um
  desenvolvedor rodando `git flow release finish` ou um push manual em `develop` pode esbarrar
  num push rejeitado se coincidir com uma promoção em andamento. Fricção nova, não um bug.
- **Segundo NLB público aumenta a superfície exposta na internet** — mesma ressalva já registrada
  na spec de observabilidade pra produção ("sem WAF/autenticação de borda") agora vale pros dois
  endereços, não só um. `core-server` já tem seus próprios guards (Basic Auth em `/docs`), então o
  risco incremental é o mesmo perfil, só duplicado.
- **Migração do `deployment.yaml`/`service.yaml` atuais pra `base/` + overlays é uma mudança
  estrutural, não incremental** — todo `kubectl`/ArgoCD que hoje aponta pro path antigo
  (`infrastructure/k8s/core-server`) precisa saber que o path de produção mudou pra
  `infrastructure/k8s/core-server/overlays/production`. A `Application` de produção sendo atualizada
  no mesmo `apply` que cria a de development evita um período em que uma delas aponta pra um path
  que não existe mais.
- **`promote`'s lógica de escolher o overlay por `GITHUB_REF_NAME`** depende de `develop`/`master`
  serem exatamente esses nomes — se o repositório algum dia renomear essas branches, esse mapeamento
  hardcoded quebra silenciosamente (o job continuaria rodando, mas escrevendo no overlay errado).
  Aceitável hoje porque os nomes já são uma convenção fixa do git-flow deste projeto, documentada no
  `CLAUDE.md`.

## Resultado

_(preenchido depois da implementação)_
