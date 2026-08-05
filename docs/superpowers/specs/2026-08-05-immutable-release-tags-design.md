# Tags de release imutáveis — promoção de imagem via GitOps

## Contexto

`infrastructure/terraform/argocd.tf`'s `kubectl_manifest.core_server_application` e
`infrastructure/k8s/core-server/deployment.yaml` já documentam a lacuna que esta spec fecha, cada
um com um comentário próprio: `targetRevision = "HEAD"` (rastreia a ponta da branch, não um
commit/tag fixo) e `image: ghcr.io/gravinawill/ruguin/core-server:latest` (tag móvel — o mesmo nome
pode apontar pra bytes diferentes a qualquer momento). Esta é a próxima sub-wave da sequência de
segurança já aprovada (ESO → Valkey → **tags imutáveis** → TLS no NLB).

A imagem certa já existe: `.github/workflows/release-image.yml`'s job `image` builda, escaneia
(Trivy), assina (cosign keyless) e publica em todo push pra `develop`/`master`, com
`docker/metadata-action` gerando `sha-<commit>` (sempre), `{{version}}` (só em tag `v*`) e `latest`
(só na branch default) — `steps.build.outputs.digest` já é o identificador mais preciso disso tudo,
o mesmo que o Trivy escaneou e o cosign assinou. O que falta é só um mecanismo apontando
`deployment.yaml` pra essa imagem automaticamente; hoje isso é 100% manual (o comentário em
`deployment.yaml` já diz "bump this line", sem nenhuma automação fazendo isso).

## Decisões

### 1. Um novo job em `release-image.yml` commita a promoção — não um controller dedicado

Pesquisei o `argocd-image-updater` (projeto oficial do Argo, sob `argoproj-labs`) antes de decidir:
ativo (commits recentes, release `v1.2.2` em 2026-06), mas com um problema real e específico para
este repositório — a issue #1660 (aberta, sem fix) documenta que a paginação de tags do GHCR quebra
depois de 100 tags, tornando tags novas invisíveis pra ferramenta sem nenhum aviso. Como este
projeto cria uma tag `sha-<commit>` nova a cada push em `develop`/`master`, esse limite seria
atingido em poucas semanas no ritmo atual. O próprio README da ferramenta também ainda diz
textualmente que não é recomendada para produção crítica.

Em vez disso: o job `image` existente ganha um output (`digest: ${{ steps.build.outputs.digest }}`)
e um novo job `promote` — condicionado a `github.event_name != 'pull_request'` e
`github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/master'` — faz checkout, atualiza a
linha `image:` de `infrastructure/k8s/core-server/deployment.yaml` pro digest novo, e commita de
volta na mesma branch com uma identidade de bot (`github-actions[bot]`). Sem controller novo no
cluster, sem credencial de registry separada pra manter, sem exposição ao bug de paginação — a
lógica de promoção fica visível no mesmo workflow que já faz o resto da cadeia de suprimentos.

```yaml
jobs:
  image:
    # ... (inalterado até o final)
    outputs:
      digest: ${{ steps.build.outputs.digest }}

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

      - name: Update deployment image digest
        run: |
          sed -i -E "s#image: ${IMAGE}(:[^[:space:]]+|@sha256:[a-f0-9]+)#image: ${IMAGE}@${DIGEST}#" \
            infrastructure/k8s/core-server/deployment.yaml
        env:
          IMAGE: ${{ env.IMAGE }}
          DIGEST: ${{ needs.image.outputs.digest }}

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git diff --quiet -- infrastructure/k8s/core-server/deployment.yaml && exit 0
          git add infrastructure/k8s/core-server/deployment.yaml
          git commit -m "chore(deploy): promote core-server to ${DIGEST}"
          git push
        env:
          DIGEST: ${{ needs.image.outputs.digest }}
```

`develop` também promove, mesmo sem nenhuma `Application` do ArgoCD observando essa branch hoje —
preparação deliberada para um ambiente de staging futuro, aceita conscientemente mesmo sem efeito
prático imediato (ver Riscos).

### 2. Prevenção de loop: `paths-ignore` no trigger de push

O commit do job `promote` só toca `infrastructure/k8s/core-server/deployment.yaml` — sem essa
exclusão, esse mesmo push disparia `release-image.yml` de novo, rebuildando a mesma imagem sob um
commit diferente (o de promoção) e tentando promover de novo. `on.push.paths-ignore` resolve isso
de forma explícita, ao contrário de depender de `[skip ci]` na mensagem do commit (que também
pularia workflows não relacionados a este):

```yaml
on:
  push:
    branches: [master, develop]
    tags: ['v*']
    paths-ignore: ['infrastructure/k8s/**']
```

`concurrency: group: release-image-${{ github.workflow }}-${{ github.ref }}, cancel-in-progress:
true` (já existente) continua cobrindo corridas entre pushes próximos na mesma branch — nenhuma
mudança necessária ali.

### 3. `targetRevision` continua `HEAD` — o problema nunca foi essa parte

`kubectl_manifest.core_server_application` não precisa mudar. O problema original não era o ArgoCD
rastrear a ponta da branch — é razoável continuar sincronizando `infrastructure/k8s/core-server/`
automaticamente. O problema era o `:latest` solto dentro desse diretório: uma vez que `image:` está
fixo num digest, o ArgoCD só reimplanta quando esse arquivo muda de verdade (via o commit do job
`promote`), não a cada ajuste não relacionado (ex: mudar um `resources.limits`) em outro arquivo do
mesmo diretório. Fixar o digest fecha a lacuna real; trocar `HEAD` por um commit fixo manual
reintroduziria o mesmo problema manual que esta spec elimina (alguém precisaria lembrar de atualizar
isso a cada deploy).

### 4. Semente inicial: `deployment.yaml` precisa de um digest real antes do primeiro `promote`

O `sed` do job `promote` precisa de um padrão consistente pra substituir — hoje a linha é
`image: ghcr.io/gravinawill/ruguin/core-server:latest`, que o regex acima já cobre (casa `:latest`
tanto quanto um `@sha256:...` anterior), então tecnicamente a primeira execução automática já
funcionaria sem preparo manual. Ainda assim, a primeira tarefa do plano de implementação deve trocar
essa linha manualmente pro digest real e atual (consultado via `gh api` ou `docker buildx imagetools
inspect ghcr.io/gravinawill/ruguin/core-server:latest`), fechando a lacuna imediatamente em vez de
esperar o próximo push — coerente com o espírito desta spec (nenhuma imagem imutável ainda
referenciada até esse commit acontecer).

## Riscos

- **Nenhuma aplicação real testada nesta sessão.** Sem cluster/ArgoCD de verdade neste ambiente —
  a verificação fica limitada a `actionlint`/revisão do YAML e, no plano de implementação, a um
  dry-run do regex de substituição contra uma cópia do arquivo real. A confirmação de que o job
  `promote` realmente comita e o ArgoCD realmente sincroniza só acontece no primeiro push real
  depois do merge.
- **`develop` promove sem efeito prático imediato.** Decisão já confirmada com o usuário: prepara
  terreno para um ambiente de staging futuro que ainda não existe. Até esse ambiente ser criado, os
  commits de bot em `develop` não mudam nada do que roda de verdade — aceito conscientemente, não
  um descuido.
- **`contents: write` é um escopo mais amplo que o resto do workflow tem hoje** (`contents: read` no
  nível do workflow, `packages: write`/`id-token: write` só no job `image`). Escopado ao mínimo
  necessário: só o job `promote` ganha essa permissão, não o workflow inteiro nem o job `image`.
- **Corrida entre `develop` e `master` não existe** — são refs diferentes, cada uma com seu próprio
  grupo de concorrência (`${{ github.ref }}` já está na chave), então um push em cada branch nunca
  cancela o outro nem escreve no mesmo arquivo ao mesmo tempo (cada branch tem sua própria cópia de
  `deployment.yaml`).
- **`argocd-image-updater` foi conscientemente descartado**, não esquecido — ver Decisão 1. Se o
  ritmo de commits deste projeto mudar drasticamente (ex: múltiplos serviços, dezenas de pushes por
  hora) ou a issue #1660 for corrigida, vale reconsiderar; não é o caso hoje.

## Resultado

_(preenchido depois da implementação)_
