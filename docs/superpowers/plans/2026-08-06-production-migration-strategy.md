# Estratégia de Migrations em Produção — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer `prisma migrate deploy` rodar automaticamente e com segurança contra produção
(e development) antes de cada deploy do core-server, sem downtime, e documentar as regras que
mantêm cada migration individual segura.

**Architecture:** Um novo estágio de build (`migrator`) no `Dockerfile` do core-server, publicado
como imagem própria pelo CI, consumido por um `Job` do Kubernetes anotado como hook `PreSync` do
ArgoCD — roda antes do `Deployment` sincronizar; se falhar, o `Deployment` novo nunca sobe. Um guia
de referência documenta as regras de migration segura e o runbook de rollback.

**Tech Stack:** Prisma 7 (`prisma migrate deploy`), Docker/Buildx multi-arch, GitHub Actions, ArgoCD
PreSync hooks, Kustomize.

## Global Constraints

- Nenhuma migration em produção pode travar/derrubar o serviço, nem quebrar o código da release
  anterior ainda servindo tráfego durante o rollout — ver
  `docs/superpowers/specs/2026-08-06-production-migration-strategy-design.md` §Objetivo.
- Rollback é forward-only: nunca reverter uma migration aplicada, só escrever uma corretiva nova
  (spec, Decisão 10).
- `runner` (a imagem que a app já publica) continua sem nenhuma dependência nativa em runtime — o
  binário nativo do schema-engine do Prisma só entra na imagem nova `migrator` (spec, Decisão 2).
- Todo `CONCURRENTLY` (índice) vive sozinho em seu próprio arquivo de migration — Postgres recusa
  `CONCURRENTLY` dentro de transação, e o Prisma envolve cada `migration.sql` numa (spec, Decisão 5).

---

### Task 1: Estágio `migrator` no Dockerfile do core-server

**Files:**

- Modify: `apps/core-server/Dockerfile:38-40` (insere um novo estágio entre `builder` e `runner`)

**Interfaces:**

- Consumes: nada de outra task.
- Produces: um build target Docker chamado `migrator` que, ao rodar sem override de `command`,
  executa `prisma migrate deploy` lendo `DATABASE_URL` do ambiente. Task 2 consome esse nome de
  target (`--target migrator`); Task 3 referencia a imagem publicada a partir dele por nome
  (`ghcr.io/gravinawill/ruguin/core-server-migrator`).

- [ ] **Step 1: Provar que o target não existe ainda**

Rode a partir da raiz do repo:

```bash
docker build --target migrator -t core-server-migrator-smoke -f apps/core-server/Dockerfile .
```

Esperado: falha, `target stage "migrator" could not be found` (ou equivalente) — o estágio ainda
não existe no Dockerfile.

- [ ] **Step 2: Adicionar o estágio `migrator`**

Em `apps/core-server/Dockerfile`, entre o fim do estágio `builder` (linha 38, `&& pnpm --filter
@ruguin/core-server deploy --prod --legacy /prod`) e o início do estágio `runner` (linha 40,
`FROM node:26.5.1-alpine AS runner`), insira:

```dockerfile

# Estágio separado do Job PreSync do ArgoCD (infrastructure/k8s/core-server/base/migration-job.yaml)
# — `prisma migrate deploy` precisa da CLI mais o binário nativo do schema-engine, e nenhum dos dois
# está em `runner`: `runner` copia só `/prod`, que `pnpm deploy --prod` monta filtrando pelo `files`
# de package.json (`["dist"]` — nunca inclui `prisma/`), e `prisma` é devDependency, então some do
# `/prod` de qualquer forma.
#
# Não estende `builder`: aquele estágio é fixado em $BUILDPLATFORM pra `prisma generate` não rodar
# sob QEMU (comentário acima) — mas o binário do schema-engine que `migrate deploy` usa em runtime é
# específico de arquitetura, o oposto do que `builder` garante. Sem override de `--platform` aqui,
# igual a `runner` abaixo, pro buildx resolver a arquitetura certa por plataforma alvo — o mesmo
# padrão que o `apk add` do tini em `runner` já usa com sucesso em build multi-arch.
FROM node:26.5.1-alpine AS migrator
RUN apk add --no-cache openssl=3.5.7-r0
WORKDIR /app
# Install isolado (sem copiar o package.json do core-server) pra não resolver as ~60 dependências
# não relacionadas (@nestjs/* etc.) que estão lá — só a CLI e sua dependência nativa
# (@prisma/engines, baixada pelo postinstall do próprio pacote). Versão travada manualmente, mesmo
# padrão que este Dockerfile já usa pra openssl/tini acima: atualizar esse número junto de qualquer
# bump de prisma/@prisma/client em apps/core-server/package.json.
RUN npm install prisma@7.9.1
COPY --from=builder /repo/apps/core-server/prisma ./prisma
COPY --from=builder /repo/apps/core-server/prisma.config.ts ./prisma.config.ts
ENTRYPOINT ["node_modules/.bin/prisma"]
CMD ["migrate", "deploy"]
```

- [ ] **Step 3: Buildar o target e confirmar que a imagem tem o que precisa**

```bash
docker build --target migrator -t core-server-migrator-smoke -f apps/core-server/Dockerfile .
docker run --rm --entrypoint sh core-server-migrator-smoke -c \
  'ls node_modules/.bin/prisma && ls prisma/migrations && ls prisma.config.ts'
```

Esperado: os três `ls` retornam sem erro (o `docker build` do Step 1 falhava; agora tem que
completar com sucesso).

- [ ] **Step 4: Rodar `migrate deploy` de verdade contra um Postgres real**

```bash
docker run -d --name core-server-migrate-test-pg \
  -e POSTGRES_USER=ruguin -e POSTGRES_PASSWORD=ruguin -e POSTGRES_DB=ruguin \
  -p 5433:5432 postgres:16-alpine
sleep 3
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL="postgresql://ruguin:ruguin@host.docker.internal:5433/ruguin?schema=migrator_smoke_test" \
  core-server-migrator-smoke
```

Esperado: log terminando em `All migrations have been successfully applied.`, listando as
migrations existentes em `apps/core-server/prisma/migrations/`.

- [ ] **Step 5: Confirmar que reaplicar é idempotente**

Rode o mesmo `docker run` do Step 4 de novo, sem mudar nada.

Esperado: `No pending migrations to apply.` — importante porque o Job de produção (Task 3) roda em
**todo** deploy, não só quando existe migration nova.

- [ ] **Step 6: Limpar os recursos de teste**

```bash
docker rm -f core-server-migrate-test-pg
docker rmi core-server-migrator-smoke
```

- [ ] **Step 7: Commit**

```bash
git add apps/core-server/Dockerfile
git commit -m "feat(core-server): add migrator Dockerfile stage for prisma migrate deploy"
```

---

### Task 2: Publicar a imagem `migrator` no CI

**Files:**

- Modify: `.github/workflows/release-image.yml`

**Interfaces:**

- Consumes: o build target `migrator` da Task 1 (`docker build --target migrator`).
- Produces: uma imagem publicada em `ghcr.io/${{ github.repository }}/core-server-migrator`
  (escaneada, com SBOM, assinada — mesmo padrão da imagem principal) e um segundo digest disponível
  para o job `promote` gravar nos overlays. Task 3 referencia essa imagem pelo nome literal
  `ghcr.io/gravinawill/ruguin/core-server-migrator`.

- [ ] **Step 1: Adicionar `MIGRATOR_IMAGE` ao `env:` do workflow**

Em `.github/workflows/release-image.yml`, no bloco `env:` do topo do arquivo (linhas 19-20):

```yaml
env:
  IMAGE: ghcr.io/${{ github.repository }}/core-server
  MIGRATOR_IMAGE: ghcr.io/${{ github.repository }}/core-server-migrator
```

- [ ] **Step 2: Adicionar o job `migrator-image`**

Logo após o fim do job `image` (depois da step `Sign the image`, antes de `promote:`), adicione:

```yaml
  migrator-image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Set up Buildx
        uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3

      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Derive tags
        id: meta
        uses: docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051 # v5
        with:
          images: ${{ env.MIGRATOR_IMAGE }}
          tags: |
            type=sha,prefix=sha-,format=long
            type=raw,value=latest,enable={{is_default_branch}}

      # target: migrator — hadolint já cobriu este Dockerfile no job `image` acima, não precisa
      # rodar de novo pro mesmo arquivo.
      - name: Build and push
        id: build
        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6
        with:
          context: .
          file: apps/core-server/Dockerfile
          target: migrator
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          provenance: mode=max
          sbom: true
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Scan the image (linux/amd64)
        if: github.event_name != 'pull_request'
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: ${{ env.MIGRATOR_IMAGE }}@${{ steps.build.outputs.digest }}
          format: table
          exit-code: '1'
          severity: HIGH,CRITICAL
          ignore-unfixed: true
        env:
          TRIVY_PLATFORM: linux/amd64

      - name: Scan the image (linux/arm64)
        if: github.event_name != 'pull_request'
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: ${{ env.MIGRATOR_IMAGE }}@${{ steps.build.outputs.digest }}
          format: table
          exit-code: '1'
          severity: HIGH,CRITICAL
          ignore-unfixed: true
        env:
          TRIVY_PLATFORM: linux/arm64

      - name: Generate SBOM (linux/amd64)
        if: github.event_name != 'pull_request'
        uses: anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610 # v0
        with:
          image: ${{ env.MIGRATOR_IMAGE }}@${{ steps.build.outputs.digest }}
          format: cyclonedx-json
          artifact-name: core-server-migrator-sbom-linux-amd64.cdx.json
        env:
          SYFT_PLATFORM: linux/amd64

      - name: Generate SBOM (linux/arm64)
        if: github.event_name != 'pull_request'
        uses: anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610 # v0
        with:
          image: ${{ env.MIGRATOR_IMAGE }}@${{ steps.build.outputs.digest }}
          format: cyclonedx-json
          artifact-name: core-server-migrator-sbom-linux-arm64.cdx.json
        env:
          SYFT_PLATFORM: linux/arm64

      - name: Install cosign
        if: github.event_name != 'pull_request'
        uses: sigstore/cosign-installer@398d4b0eeef1380460a10c8013a76f728fb906ac # v3

      - name: Sign the image
        if: github.event_name != 'pull_request'
        run: cosign sign --yes "${IMAGE}@${DIGEST}"
        env:
          IMAGE: ${{ env.MIGRATOR_IMAGE }}
          DIGEST: ${{ steps.build.outputs.digest }}
```

- [ ] **Step 3: Fazer `promote` depender dos dois jobs**

Em `promote:` (hoje `needs: image`), troque para:

```yaml
  promote:
    needs: [image, migrator-image]
```

- [ ] **Step 4: Substituir a lógica de digest do `promote` por uma ancorada por nome de imagem**

A lógica atual (`sed` substituindo o primeiro `digest: sha256:...` que encontrar) só funciona com
uma entrada em `images:` por overlay — o comentário no próprio arquivo já avisa disso. Com duas
imagens, troque o step `Update overlay image digest` inteiro por:

```yaml
      - name: Update overlay image digest
        run: |
          set -euo pipefail
          update_digest() {
            local name="$1" digest="$2"
            [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || {
              echo "::error::refusing to promote invalid digest '$digest' for $name"
              exit 1
            }
            yq eval "(.images[] | select(.name == \"${name}\") | .digest) = \"${digest}\"" \
              -i "infrastructure/k8s/core-server/overlays/${OVERLAY}/kustomization.yaml"
          }
          update_digest "$IMAGE" "$DIGEST"
          update_digest "$MIGRATOR_IMAGE" "$MIGRATOR_DIGEST"
        env:
          IMAGE: ${{ env.IMAGE }}
          DIGEST: ${{ needs.image.outputs.digest }}
          MIGRATOR_IMAGE: ${{ env.MIGRATOR_IMAGE }}
          MIGRATOR_DIGEST: ${{ needs.migrator-image.outputs.digest }}
          OVERLAY: ${{ github.ref_name == 'develop' && 'development' || 'production' }}
```

`yq` (mikefarah/yq) já vem instalado nos runners `ubuntu-latest` do GitHub Actions — não precisa de
step de instalação.

- [ ] **Step 5: Validar a sintaxe do workflow**

```bash
actionlint .github/workflows/release-image.yml
```

Esperado: sem output (sem erros). Se `actionlint` não estiver instalado localmente:
`brew install actionlint`.

- [ ] **Step 6: Validar a substituição de digest localmente**

Sem precisar instalar `yq` se já não tiver (`brew install yq`), rode contra uma cópia:

```bash
cp infrastructure/k8s/core-server/overlays/production/kustomization.yaml /tmp/kustomization-check.yaml
yq eval '.images += [{"name": "ghcr.io/gravinawill/ruguin/core-server-migrator", "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"}]' \
  -i /tmp/kustomization-check.yaml
yq eval '(.images[] | select(.name == "ghcr.io/gravinawill/ruguin/core-server") | .digest) = "sha256:aaaa111111111111111111111111111111111111111111111111111111111111"' \
  -i /tmp/kustomization-check.yaml
yq eval '(.images[] | select(.name == "ghcr.io/gravinawill/ruguin/core-server-migrator") | .digest) = "sha256:bbbb222222222222222222222222222222222222222222222222222222222222"' \
  -i /tmp/kustomization-check.yaml
cat /tmp/kustomization-check.yaml
rm /tmp/kustomization-check.yaml
```

Esperado: as duas entradas de `images:` com digests diferentes e corretos (`aaaa...` na de
`core-server`, `bbbb...` na de `core-server-migrator`), comentários do arquivo original
preservados.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/release-image.yml
git commit -m "ci(release-image): build, scan and publish the core-server-migrator image"
```

---

### Task 3: Job PreSync do ArgoCD + wiring no Kustomize

**Files:**

- Create: `infrastructure/k8s/core-server/base/migration-job.yaml`
- Modify: `infrastructure/k8s/core-server/base/kustomization.yaml`
- Modify: `infrastructure/k8s/core-server/overlays/production/kustomization.yaml`
- Modify: `infrastructure/k8s/core-server/overlays/development/kustomization.yaml`

**Interfaces:**

- Consumes: nome da imagem publicada pela Task 2
  (`ghcr.io/gravinawill/ruguin/core-server-migrator`); `Secret`s `core-server-secrets` e
  `ghcr-pull-secret`, já existentes nos dois namespaces (`infrastructure/terraform/external-secrets.tf`).
- Produces: um `Job` do Kubernetes que ArgoCD executa como hook `PreSync` antes de sincronizar o
  `Deployment`, em ambos os overlays.

- [ ] **Step 1: Criar `infrastructure/k8s/core-server/base/migration-job.yaml`**

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: core-server-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 300
  template:
    spec:
      restartPolicy: Never
      imagePullSecrets:
        - name: ghcr-pull-secret
      containers:
        - name: migrate
          image: ghcr.io/gravinawill/ruguin/core-server-migrator
          envFrom:
            - secretRef:
                name: core-server-secrets
          resources:
            requests: { cpu: 100m, memory: 128Mi, ephemeral-storage: 128Mi }
            limits: { cpu: 100m, memory: 128Mi, ephemeral-storage: 128Mi }
```

- [ ] **Step 2: Registrar o Job em `base/kustomization.yaml`**

Em `infrastructure/k8s/core-server/base/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
  - migration-job.yaml
```

- [ ] **Step 3: Adicionar a segunda imagem em cada overlay**

Em `infrastructure/k8s/core-server/overlays/production/kustomization.yaml`, no bloco `images:`
existente, adicione uma segunda entrada (mantendo o comentário já existente acima do bloco):

```yaml
images:
  - name: ghcr.io/gravinawill/ruguin/core-server
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
  - name: ghcr.io/gravinawill/ruguin/core-server-migrator
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
```

Repita a mesma edição (mesmo placeholder) em
`infrastructure/k8s/core-server/overlays/development/kustomization.yaml`.

- [ ] **Step 4: Renderizar os dois overlays e conferir**

```bash
kubectl kustomize infrastructure/k8s/core-server/overlays/production
kubectl kustomize infrastructure/k8s/core-server/overlays/development
```

Esperado, em cada saída: um documento `kind: Job` com `name: core-server-migrate`, as anotações
`argocd.argoproj.io/hook: PreSync` e `hook-delete-policy: HookSucceeded` intactas, `namespace:`
igual ao do `Deployment` no mesmo render (`core-server` em production, `core-server-dev` em
development), `image:` terminando em `core-server-migrator@sha256:000...000` (o placeholder — vira
digest real só depois que a Task 2 publicar e o `promote` do CI rodar).

- [ ] **Step 5: Commit**

```bash
git add infrastructure/k8s/core-server/base/migration-job.yaml \
  infrastructure/k8s/core-server/base/kustomization.yaml \
  infrastructure/k8s/core-server/overlays/production/kustomization.yaml \
  infrastructure/k8s/core-server/overlays/development/kustomization.yaml
git commit -m "feat(infra): add ArgoCD PreSync migration Job to core-server kustomize base"
```

---

### Task 4: Guia de migrations seguras + runbook de rollback

**Files:**

- Create: `docs/database-migrations-guide.md`

**Interfaces:**

- Consumes: nada de outra task.
- Produces: documento de referência citado pela spec (Decisão 11) como o que a revisão de PR
  confere quando o diff toca `prisma/migrations/`.

- [ ] **Step 1: Escrever `docs/database-migrations-guide.md`**

````markdown
# Guia de Migrations de Banco em Produção

**Escopo:** regras para escrever migrations Prisma que não derrubam nem travam produção, e o
runbook de rollback quando uma migration causa problema. Aplica a qualquer app do monorepo que use
Prisma contra Postgres (`core-server` hoje; `ses-webhook-ingestor` e futuros apps quando ganharem
overlay de produção). Mecanismo de execução (quando/onde `prisma migrate deploy` roda) é o Job
PreSync do ArgoCD — ver
`docs/superpowers/specs/2026-08-06-production-migration-strategy-design.md`.

## 1. Toda mudança estrutural é expand/contract

Nenhuma migration muda o schema de um jeito que quebra o código da release anterior — durante um
rollout, código velho e novo servem tráfego ao mesmo tempo. Renomear coluna, mudar tipo, remover
coluna em uso: nunca em um passo só, sempre como sequência de deploys:

1. **Expand** — adiciona o novo shape, código passa a escrever nos dois lugares.
2. **Migrate** — backfill dos dados existentes para o novo shape.
3. **Contract** — só depois que o rollout anterior estabilizou e nada mais lê o shape antigo,
   remove-o.

## 2. Índice ou constraint única: sempre `CONCURRENTLY`, um statement por arquivo

`CREATE INDEX`/`DROP INDEX` sem `CONCURRENTLY` trava escrita na tabela inteira até terminar de
construir. Regra: sempre `CONCURRENTLY`. E porque o Postgres recusa `CONCURRENTLY` dentro de uma
transação — e o Prisma envolve cada `migration.sql` numa — cada statement `CONCURRENTLY` vive
sozinho no seu próprio arquivo:

```sql
-- migration A: só isso, nada mais no arquivo
DROP INDEX CONCURRENTLY IF EXISTS "emails_projectId_idx";
```

```sql
-- migration B, arquivo separado
CREATE INDEX CONCURRENTLY "emails_projectId_idx" ON "emails"("projectId");
```

## 3. Foreign key ou CHECK numa tabela existente: `NOT VALID` + `VALIDATE CONSTRAINT`

`ADD CONSTRAINT` direto escaneia e trava a tabela inteira pra validar linhas existentes. Em duas
migrations: `... ADD CONSTRAINT ... NOT VALID` (lock rápido, não escaneia, vale só a partir dali) e
depois `... VALIDATE CONSTRAINT ...` (lock mais leve, não bloqueia escrita concorrente).

## 4. Coluna nova: sem reescrever a tabela

`DEFAULT` constante ou nullable não reescreve a tabela (Postgres 11+). Pra exigir `NOT NULL`: coluna
nullable → backfill em lote (regra 5) → só então `ALTER COLUMN ... SET NOT NULL`.

## 5. Backfill grande: em lote, nunca um `UPDATE` cobrindo a tabela inteira

Nenhuma migration roda `UPDATE`/`DELETE` sem filtro sobre uma tabela inteira. Lote de tamanho fixo
(ex.: `WHERE id BETWEEN ... AND ...`, repetido), pra não segurar uma transação longa nem inchar o
WAL.

## 6. `lock_timeout` curto na sessão de migration

Sem isso, uma migration que esbarra numa query longa já em andamento fica na fila de lock — e tudo
que vier depois dela na mesma tabela enfileira atrás, inclusive tráfego normal da app. É o cenário
clássico de "uma migration derrubou a produção inteira". `lock_timeout` curto faz a migration falhar
rápido em vez disso — falha visível no Job de deploy é preferível a lock silencioso em cascata.

## 7. Checklist de revisão de PR

Quando o diff toca `prisma/migrations/`, confira:

- [ ] Mudança estrutural (rename/type change/drop coluna em uso) está fatiada em
      expand → migrate → contract, não num passo só? (regra 1)
- [ ] Todo `CREATE INDEX`/`DROP INDEX` usa `CONCURRENTLY`, cada um em arquivo próprio? (regra 2)
- [ ] Toda `FOREIGN KEY`/`CHECK` nova numa tabela com dados usa `NOT VALID` + `VALIDATE CONSTRAINT`
      separados? (regra 3)
- [ ] Coluna `NOT NULL` nova passou por nullable → backfill → `SET NOT NULL`? (regra 4)
- [ ] Nenhum `UPDATE`/`DELETE` sem filtro de lote sobre uma tabela inteira? (regra 5)

## 8. Rollback: forward-only

Prisma Migrate não tem down-migration nativa — cada migration é só um `up`. Nenhuma migration
aplicada em produção é revertida. Um problema vira uma **nova migration corretiva**, nunca uma
tentativa de desfazer a anterior.

**Runbook — migration causou problema em produção:**

1. Se o Job de migration falhou: nada a reverter, o `Deployment` novo nunca subiu, código velho
   nunca deixou de servir. Corrija a migration e deploye de novo.
2. Se a migration **aplicou com sucesso** mas o efeito é indesejado (índice errado, coluna com
   default errado): escreva uma migration corretiva normal (`prisma migrate dev` local pra gerar o
   arquivo) e deploye como qualquer outra mudança.
3. `prisma migrate resolve --rolled-back` só depois que o dado já foi corrigido manualmente fora do
   fluxo normal (incidente grave com intervenção direta no banco) — destrava o histórico do Prisma
   nesse cenário, nunca é a primeira resposta.
````

- [ ] **Step 2: Formatar com prettier**

```bash
npx prettier@3.9.6 --write docs/database-migrations-guide.md
```

Esperado: sem diff adicional (o conteúdo do Step 1 já segue a formatação padrão do repo — se
prettier reescrever algo, revise antes de seguir).

- [ ] **Step 3: Commit**

```bash
git add docs/database-migrations-guide.md
git commit -m "docs: add database migrations guide with safe-migration checklist and rollback runbook"
```

---

## Self-Review (autoral, feito ao escrever este plano)

- **Cobertura da spec**: Decisão 1 (mecanismo) → Task 3. Decisão 2 (imagem migrator) → Tasks 1-2.
  Decisão 3 (retry/limpeza do Job) → Task 3, Step 1 (`backoffLimit`/`activeDeadlineSeconds` já no
  YAML). Decisões 4-9 (regras de migration segura) e 10 (rollback) → Task 4. Decisão 11
  (enforcement via checklist documentado) → Task 4. Decisão 12 (template reutilizável) → nenhuma
  task própria: é uma característica de design (Job genérico, regras não específicas de
  core-server), não uma ação a executar hoje — só vira trabalho real quando outro serviço ganhar
  overlay de produção, fora do escopo deste plano.
- **Placeholders**: nenhum "TBD"/"implementar depois" — todo YAML, Dockerfile e Markdown deste
  plano é o conteúdo final, já testado localmente (Tasks 1, 2 e 3 rodadas de verdade durante o
  planejamento: build+run do estágio `migrator` contra Postgres real duas vezes, `actionlint` limpo
  na baseline, substituição de digest via `yq` testada contra uma cópia real do
  `kustomization.yaml`, e `kubectl kustomize` renderizado para os dois overlays com o Job incluído).
- **Consistência de nomes**: `ghcr.io/gravinawill/ruguin/core-server-migrator` é o mesmo literal em
  Task 2 (workflow `env.MIGRATOR_IMAGE`), Task 3 (`migration-job.yaml` e os dois
  `kustomization.yaml`) e na spec (Decisão 2). `core-server-secrets`/`ghcr-pull-secret` são os
  nomes reais já em uso pelo `Deployment` (`infrastructure/k8s/core-server/base/deployment.yaml`),
  reaproveitados sem alteração.
