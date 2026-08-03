# DevOps Onda 1 — Do código ao artefato assinado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produzir, a cada merge, uma imagem de container versionada, rastreável até o commit, verificada quanto a vulnerabilidades e assinada.

**Architecture:** O `turbo prune` recorta o monorepo para o subconjunto que o `core-server` precisa; um Dockerfile de três estágios instala, compila e entrega uma imagem Alpine sem engine nativo do Prisma, com `tini` como PID 1. O CI publica no GHCR em duas arquiteturas e anexa SBOM, relatório de scan e assinatura keyless.

**Tech Stack:** Docker buildx, Turborepo 2.10.8, pnpm 11.18.0, Node 26.5.1 Alpine, GitHub Actions, Syft, Trivy, cosign, semantic-release 25.

## Global Constraints

- Node **26.5.0** (`.nvmrc`); imagem base **`node:26.5.1-alpine`**.
- Gerenciador **pnpm 11.18.0**; toda instalação em CI usa `--frozen-lockfile`.
- Toda GitHub Action é referenciada **por SHA de commit**, com a tag em comentário ao lado.
- Todo workflow declara `permissions:` explicitamente, no menor escopo que o job precisa.
- Registro de imagens: **GHCR** (`ghcr.io/gravinawill/ruguin/core-server`).
- Mensagens de commit seguem **Conventional Commits** (validado por commitlint).
- Código, nomes de teste, comentários e mensagens de commit em **inglês**.
- Comentário só para o que o código não diz; nunca reafirmar a linha abaixo.
- Nenhum arquivo passa de **500 linhas**.
- Falha esperada retorna `Either` de `@ruguin/utils`; `throw` é para bug.

---

### Task 1: Devolver o ponto de injeção a `createPinoHttpOptions`

Sete testes estão vermelhos porque a função passou a ler `serverENV` direto e o teste não tem como
fornecer um ambiente. A correção mantém o env tipado como padrão e aceita um substituto.

**Files:**
- Modify: `apps/core-server/src/shared/infrastructure/logger/pino-http-options.ts`
- Modify: `apps/core-server/src/shared/infrastructure/logger/__tests__/pino-http-options.unit.ts`
- Modify: `apps/core-server/src/app.module.ts` (chamada de `createPinoHttpOptions`)

**Interfaces:**
- Consumes: `serverENV` e o tipo `Environment` de `@ruguin/env`.
- Produces: `createPinoHttpOptions(environment?: { ENVIRONMENT: Environment }): Options` — o
  parâmetro é opcional e cai em `serverENV` quando omitido.

- [ ] **Step 1: Escrever os testes que falham**

Substitua o conteúdo de `apps/core-server/src/shared/infrastructure/logger/__tests__/pino-http-options.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createPinoHttpOptions } from '../pino-http-options'

describe('createPinoHttpOptions', () => {
  it('uses debug level and pretty-prints outside production', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })

    expect(options.level).toBe('debug')
    expect(options.transport).toEqual({ target: 'pino-pretty' })
  })

  it('uses info level and drops pretty-print in production', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'production' })

    expect(options.level).toBe('info')
    expect(options.transport).toBeUndefined()
  })

  it('redacts the authorization header', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })

    expect(options.redact).toContain('req.headers.authorization')
  })

  it('keeps a 4xx at warn so an anonymous client cannot generate ERROR at will', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })
    const level = options.customLogLevel?.({} as never, { statusCode: 401 } as never, undefined)

    expect(level).toBe('warn')
  })

  it('raises a 5xx to error', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })
    const level = options.customLogLevel?.({} as never, { statusCode: 503 } as never, undefined)

    expect(level).toBe('error')
  })

  it('reports error when the request failed without reaching a status code', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })
    const level = options.customLogLevel?.({} as never, { statusCode: 200 } as never, new Error('socket hang up'))

    expect(level).toBe('error')
  })
})
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm --filter @ruguin/core-server test`
Expected: FAIL — `Expected 0 arguments, but got 1` no type-check, ou os testes de nível falhando.

- [ ] **Step 3: Restaurar a injeção**

Em `apps/core-server/src/shared/infrastructure/logger/pino-http-options.ts`, troque as três
primeiras linhas e a assinatura:

```ts
import type { Options } from 'pino-http'

import { type Environment, serverENV } from '@ruguin/env'

export function createPinoHttpOptions(environment: { ENVIRONMENT: Environment } = serverENV): Options {
  const isProduction = environment.ENVIRONMENT === 'production'
```

O resto do corpo permanece igual. O padrão só é avaliado quando o argumento é omitido, então
`serverENV` continua lazy e nenhum teste unitário passa a exigir variáveis de ambiente.

- [ ] **Step 4: Ajustar a chamada no `app.module.ts`**

Localize a chamada de `createPinoHttpOptions` e deixe-a sem argumento:

```ts
LoggerModule.forRootAsync({
  useFactory: () => ({ pinoHttp: createPinoHttpOptions() })
}),
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @ruguin/core-server test`
Expected: PASS — nenhum teste vermelho.

- [ ] **Step 6: Verificar tipos e lint**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: sem saída de erro.

- [ ] **Step 7: Commit**

```bash
git add apps/core-server/src/shared/infrastructure/logger apps/core-server/src/app.module.ts
git commit -m "fix(core-server): let createPinoHttpOptions take an environment again

Reading serverENV directly is right about where env belongs and wrong about
testability: it removed the only injection point, and seven tests had no way to
describe the environment they were asserting on. The parameter comes back with
serverENV as its default, so production keeps the validated env and a test can
pass its own."
```

---

### Task 2: Cobertura com exclusões versionadas e threshold

**Files:**
- Modify: `apps/core-server/vitest.config.ts`
- Modify: `packages/cache/vitest.config.ts`
- Modify: `packages/env/vitest.config.ts`
- Modify: `packages/shared-domain/vitest.config.ts`
- Modify: `packages/utils/vitest.config.ts`

**Interfaces:**
- Consumes: a suíte verde entregue pela Task 1.
- Produces: `pnpm test:coverage` passa a reprovar abaixo do threshold.

- [ ] **Step 1: Medir a linha de base**

Run: `pnpm --filter @ruguin/core-server test:cov`
Anote os quatro números finais (statements, branches, functions, lines). Eles definem o valor
inicial do threshold no Step 3.

- [ ] **Step 2: Adicionar o bloco de cobertura ao core-server**

Em `apps/core-server/vitest.config.ts`, dentro de `test:`, logo após `passWithNoTests: true`,
insira:

```ts
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      /*
       * O alvo é 100% do código de negócio. O que sai daqui não é dívida: é código cuja cobertura
       * afirmaria que a linguagem funciona, não que a regra está certa.
       */
      exclude: [
        '**/generated/**',
        'src/main.ts',
        'src/**/*.module.ts',
        'src/**/__tests__/**',
        '**/*.config.ts',
        'scripts/**',
        'dist/**'
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    },
```

- [ ] **Step 3: Ajustar o threshold à realidade medida**

Se o Step 1 mostrou valores abaixo de 100, troque cada número pelo valor medido, arredondado para
baixo, e acrescente acima do bloco `thresholds` um comentário no formato:

```ts
      /*
       * 2026-08-02: degrau inicial. Falta cobrir <lista dos arquivos com menor cobertura>.
       * Este número só sobe. Baixá-lo para o CI passar significa que a mudança está incompleta.
       */
```

Se os quatro vieram 100, mantenha 100 e não adicione comentário.

- [ ] **Step 4: Replicar nos quatro pacotes**

Cada um de `packages/cache`, `packages/env`, `packages/shared-domain` e `packages/utils` recebe o mesmo
bloco `coverage`, com `exclude` adaptado:

```ts
      exclude: ['**/generated/**', 'src/**/__tests__/**', '**/*.config.ts', 'dist/**']
```

Meça cada pacote com `pnpm --filter <nome> test:all --coverage` antes de fixar o número, pela mesma
regra do Step 3.

- [ ] **Step 5: Verificar que o gate morde**

Run: `pnpm test:coverage`
Expected: PASS. Em seguida, suba temporariamente um dos thresholds em 5 pontos, rode de novo e
confirme FAIL com a mensagem de coverage threshold. Desfaça a alteração temporária.

- [ ] **Step 6: Commit**

```bash
git add apps/core-server/vitest.config.ts packages/*/vitest.config.ts
git commit -m "test: fail the build when coverage regresses

test:coverage measured and reported without ever failing, which made the number
decorative. The target is 100% of business code; the exclusions are the code
whose coverage would assert that the language works rather than that the rule is
right — generated client, bootstrap, module declarations."
```

---

### Task 3: Dockerfile multi-stage e `.dockerignore`

**Files:**
- Create: `apps/core-server/Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: script `build` do `@ruguin/core-server` (`prisma generate && nest build && node scripts/fix-esm-imports.mjs`).
- Produces: imagem que expõe `3333` e responde `GET /health`.

- [ ] **Step 1: Criar o `.dockerignore` na raiz**

```
node_modules
**/node_modules
dist
**/dist
build
**/build
coverage
**/coverage
.turbo
**/.turbo
.git
.github
.claude
.agents
.remember
.gitnexus
**/generated
*.log
.env
.env.*
infrastructure/local/observability
docs
```

Sem isto o contexto de build carrega o monorepo inteiro e nenhuma layer é reaproveitada.

- [ ] **Step 2: Criar `apps/core-server/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

FROM node:26.5.1-alpine AS pruner
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm dlx turbo@2.10.8 prune @ruguin/core-server --docker

FROM node:26.5.1-alpine AS builder
WORKDIR /repo
# openssl e libc6-compat existem para o schema-engine do Prisma, que é nativo e roda no generate.
RUN corepack enable && apk add --no-cache openssl libc6-compat
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
RUN pnpm --filter @ruguin/core-server build
RUN pnpm --filter @ruguin/core-server deploy --prod --legacy /prod

FROM node:26.5.1-alpine AS runner
# tini é PID 1 porque main.ts habilita shutdown hooks: sem ele o SIGTERM encerra o processo com a
# conexão do Prisma aberta em vez de fechá-la.
RUN apk add --no-cache tini \
  && addgroup -S nodejs \
  && adduser -S nestjs -G nodejs
WORKDIR /app
COPY --from=builder --chown=nestjs:nodejs /prod ./
USER nestjs
ENV NODE_ENV=production
EXPOSE 3333
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "./dist/tracing.js", "dist/main.js"]
```

- [ ] **Step 3: Construir a imagem**

Run: `docker build -f apps/core-server/Dockerfile -t ruguin/core-server:dev .`
Expected: build conclui. Se falhar em `pnpm deploy`, troque a linha por
`RUN pnpm --filter @ruguin/core-server deploy --prod /prod` (a flag `--legacy` só é necessária em
configurações com `node-linker=hoisted`); se falhar por módulo de workspace ausente, confirme que o
`out/full` foi copiado **depois** do `pnpm install`, que é o que preserva o cache de dependências.

- [ ] **Step 4: Subir o container contra a infraestrutura local**

Run:

```bash
docker run --rm -p 3333:3333 \
  -e ENVIRONMENT=local \
  -e PORT=3333 \
  -e DATABASE_URL='postgresql://ruguin:ruguin@host.docker.internal:5432/ruguin?schema=core_server' \
  -e CACHE_PREFIX=ruguin:docker \
  -e CACHE_DRIVER=memory \
  -e DOCS_USERNAME=docker \
  -e DOCS_PASSWORD=docker \
  ruguin/core-server:dev
```

Expected: log `Nest application successfully started`.

- [ ] **Step 5: Verificar o health**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3333/health`
Expected: `200`. O corpo deve trazer `database` com `status: "up"` — é a prova de que o client do
Prisma funciona em Alpine sem engine nativo.

- [ ] **Step 6: Verificar o desligamento gracioso**

Com o container rodando, execute `docker stop <id>` e observe o log.
Expected: o processo encerra em menos de 10 segundos, sem o SIGKILL que o Docker envia após o
timeout. Um encerramento que só termina no timeout indica que o `tini` não está como PID 1.

- [ ] **Step 7: Conferir o tamanho**

Run: `docker image ls ruguin/core-server:dev --format '{{.Size}}'`
Anote o valor. Acima de 400MB, verifique se `/prod` recebeu apenas dependências de produção.

- [ ] **Step 8: Commit**

```bash
git add .dockerignore apps/core-server/Dockerfile
git commit -m "build(core-server): add a multi-stage container image

turbo prune cuts the monorepo down to what this app needs, so the dependency
layer only rebuilds when its own manifests change.

Alpine is safe here: the Prisma 7 client ships no native engine, since the query
compiler reaches Postgres through pg in plain JavaScript, so musl versus glibc
stops mattering. The schema-engine is native but only runs during generate, in
the builder.

tini is PID 1 because main.ts enables shutdown hooks — without it SIGTERM kills
the process with the database connection still open."
```

---

### Task 4: Endurecer os workflows existentes

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/security.yml`

**Interfaces:**
- Produces: workflows com `permissions` mínimo e actions fixadas por SHA — pré-requisito para as
  Tasks 5 e 6, que pedem `id-token: write` e `packages: write`.

- [ ] **Step 1: Fixar as actions e declarar permissões no `ci.yml`**

Adicione, logo após o bloco `concurrency`, e antes de `jobs:`:

```yaml
permissions:
  contents: read
```

E troque as três referências de action:

```yaml
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Setup pnpm
        uses: pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa # v4

      - name: Setup Node
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
```

- [ ] **Step 2: Fazer o mesmo no `security.yml`**

Adicione antes de `jobs:`:

```yaml
permissions:
  contents: read
```

E fixe o checkout:

```yaml
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          fetch-depth: 0
```

A `gitleaks/gitleaks-action@v2` fica como está: ela lê o `GITHUB_TOKEN` do `env` e o Dependabot já
acompanha o ecossistema `github-actions`, que passa a propor os bumps de SHA.

- [ ] **Step 3: Validar a sintaxe**

Run: `npx --yes yaml-lint .github/workflows/ci.yml .github/workflows/security.yml`
Expected: sem erro. Se o pacote não estiver disponível, use
`python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]; print('ok')" .github/workflows/ci.yml .github/workflows/security.yml`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows
git commit -m "ci: pin actions by SHA and scope the token

A tag can be moved to another commit, which is how a pipeline gets compromised
without anything in the repository changing. Dependabot already tracks the
github-actions ecosystem and will propose the SHA bumps.

Both workflows now declare contents: read; the default token scope was wider
than either job needs."
```

---

### Task 5: Publicar a imagem no GHCR

**Files:**
- Create: `.github/workflows/release-image.yml`

**Interfaces:**
- Consumes: `apps/core-server/Dockerfile` (Task 3).
- Produces: `ghcr.io/gravinawill/ruguin/core-server` com tags `sha-<commit>`, `<semver>` e `latest`.

- [ ] **Step 1: Criar o workflow**

```yaml
name: Release image

on:
  push:
    branches: [master, develop]
    tags: ['v*']
  pull_request:
    branches: [master, develop]
    types: [opened, synchronize, reopened]

concurrency:
  group: release-image-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

env:
  IMAGE: ghcr.io/${{ github.repository }}/core-server

jobs:
  image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write
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
          images: ${{ env.IMAGE }}
          tags: |
            type=sha,prefix=sha-,format=long
            type=semver,pattern={{version}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        id: build
        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6
        with:
          context: .
          file: apps/core-server/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          provenance: mode=max
          sbom: true
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

Em pull request a imagem é construída e não publicada: o build é o teste, e um PR de fork não deve
ganhar permissão de escrita no registro.

- [ ] **Step 2: Validar a sintaxe**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-image.yml')); print('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-image.yml
git commit -m "ci: build and publish the core-server image to GHCR

Two architectures because development happens on Apple Silicon and the likely
target is amd64 — finding that out at the first deploy is avoidable.

Pull requests build without pushing: the build is the test, and a fork's PR has
no business holding write access to the registry."
```

---

### Task 6: SBOM, scan e assinatura

**Files:**
- Modify: `.github/workflows/release-image.yml`

**Interfaces:**
- Consumes: `steps.build.outputs.digest` do job da Task 5.
- Produces: SBOM em CycloneDX anexado ao artefato do workflow, scan reprovando em HIGH/CRITICAL e
  assinatura keyless verificável por qualquer pessoa.

- [ ] **Step 1: Acrescentar os passos ao final do job `image`**

Após o passo `Build and push`, adicione:

```yaml
      - name: Scan the image
        if: github.event_name != 'pull_request'
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: ${{ env.IMAGE }}@${{ steps.build.outputs.digest }}
          format: table
          exit-code: '1'
          severity: HIGH,CRITICAL
          ignore-unfixed: true

      - name: Generate SBOM
        if: github.event_name != 'pull_request'
        uses: anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610 # v0
        with:
          image: ${{ env.IMAGE }}@${{ steps.build.outputs.digest }}
          format: cyclonedx-json
          artifact-name: core-server-sbom.cdx.json

      - name: Install cosign
        if: github.event_name != 'pull_request'
        uses: sigstore/cosign-installer@f713795cb21599bc4e5c4b58cbad1da852d7eeb9 # v3

      - name: Sign the image
        if: github.event_name != 'pull_request'
        run: cosign sign --yes "${IMAGE}@${DIGEST}"
        env:
          IMAGE: ${{ env.IMAGE }}
          DIGEST: ${{ steps.build.outputs.digest }}
```

Os três passos rodam apenas fora de pull request, e a razão é mecânica: com `push: false` a imagem
fica no cache do buildx e nunca chega ao registro, então `image-ref` por digest não resolve. Escanear
no PR exigiria um segundo build de arquitetura única com `load: true` — `load` não aceita
multi-arquitetura — e pagar o dobro do tempo de build por um relatório que o push repete minutos
depois. No PR o build passar já é o teste.

Se no futuro o scan em PR se mostrar necessário, o caminho é um job separado que constrói só
`linux/amd64` com `load: true` e escaneia a imagem local, sem tocar neste job.

`ignore-unfixed: true` evita reprovar por CVE sem correção disponível, que nenhuma ação do
repositório resolveria.

- [ ] **Step 2: Validar a sintaxe**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-image.yml')); print('ok')"`
Expected: `ok`.

- [ ] **Step 3: Registrar como verificar a assinatura**

Acrescente ao final de `apps/core-server/CLAUDE.md`, antes da seção `## Relacionados`:

Escreva uma seção `## Imagem` com este conteúdo: um parágrafo dizendo que a imagem publicada é
assinada com cosign em modo keyless, seguido de um bloco de código bash com o comando

    cosign verify ghcr.io/gravinawill/ruguin/core-server:latest \
      --certificate-identity-regexp '^https://github.com/gravinawill/ruguin/' \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com

e, abaixo do bloco, a frase: "Sem `--certificate-identity-regexp` a verificação aceita qualquer
assinatura válida do Sigstore, inclusive de outro repositório — o que responde *isto foi assinado*,
não *isto foi assinado por nós*."

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-image.yml apps/core-server/CLAUDE.md
git commit -m "ci: scan, describe and sign the published image

gitleaks, Dependabot and semgrep cover the code; nothing covered the image. Trivy
fails the build on HIGH and CRITICAL, Syft records what is inside, and cosign
signs it keyless — the OIDC token replaces a private key nobody would rotate.

Unfixed CVEs do not fail the build: no change in this repository would resolve
them, and a gate that cannot be satisfied gets bypassed."
```

---

### Task 7: `semantic-release`

**Files:**
- Create: `.releaserc.json`
- Create: `.github/workflows/release.yml`
- Modify: `package.json` (devDependencies)

**Interfaces:**
- Consumes: histórico em Conventional Commits, garantido pelo commitlint.
- Produces: tag `vX.Y.Z`, `CHANGELOG.md` e release do GitHub — a tag dispara a Task 5, que publica a
  imagem com a mesma versão.

- [ ] **Step 1: Instalar as dependências**

Run:

```bash
pnpm add -Dw semantic-release@25.0.8 @semantic-release/changelog@7.0.0 @semantic-release/git@11.0.1 @semantic-release/github@12.0.9
```

- [ ] **Step 2: Criar `.releaserc.json`**

```json
{
  "branches": ["master"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", { "changelogFile": "CHANGELOG.md" }],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        "assets": ["CHANGELOG.md"],
        "message": "chore(release): ${nextRelease.version} [skip ci]"
      }
    ]
  ]
}
```

`branches` traz apenas `master` porque o fluxo git flow deste repositório faz `master` receber
release e hotfix; `develop` acumula trabalho e não gera versão.

Não há `@semantic-release/npm`: nenhum pacote deste monorepo é publicado, e o plugin tentaria
`npm publish`.

- [ ] **Step 3: Criar `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    branches: [master]

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
      id-token: write
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Setup pnpm
        uses: pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa # v4

      - name: Setup Node
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
        with:
          node-version-file: '.nvmrc'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Release
        run: pnpm exec semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`fetch-depth: 0` existe porque o semantic-release lê o histórico para decidir a versão.
`cancel-in-progress: false` evita interromper uma release no meio, que deixaria tag publicada sem
release correspondente.

- [ ] **Step 4: Validar a configuração sem publicar**

Run: `pnpm exec semantic-release --dry-run --no-ci`
Expected: imprime a próxima versão calculada a partir dos commits. Se disser que não há release a
fazer, é porque nenhum commit desde a última tag é `feat` ou `fix` — o que é uma resposta válida.

- [ ] **Step 5: Validar a sintaxe do workflow**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('ok')"`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add .releaserc.json .github/workflows/release.yml package.json pnpm-lock.yaml
git commit -m "ci: derive releases from the commit history

commitlint already enforces Conventional Commits, so the version was sitting in
the history waiting to be read.

Only master releases: git flow has master receive release and hotfix while
develop accumulates work. No npm plugin — nothing here is published, and the
plugin would try."
```

---

### Task 8: Fechar a onda

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-devops-artifact-pipeline-design.md`

- [ ] **Step 1: Rodar a verificação completa**

Run: `pnpm run check && pnpm build && npx turbo test:all`
Expected: os três passam.

- [ ] **Step 2: Confirmar que a imagem ainda constrói**

Run: `docker build -f apps/core-server/Dockerfile -t ruguin/core-server:final .`
Expected: build conclui.

- [ ] **Step 3: Registrar o resultado no spec**

Ao final do spec, acrescente uma seção `## Resultado`, com: o tamanho final da imagem, os números de
cobertura efetivamente aplicados por pacote, e qualquer decisão do plano que a implementação
precisou mudar — em especial se `pnpm deploy` exigiu flag diferente ou se algum threshold entrou em
degrau em vez de 100.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-02-devops-artifact-pipeline-design.md
git commit -m "docs: record what wave 1 actually produced"
```

---

## Ordem e dependências

```
Task 1 (injeção)  →  Task 2 (cobertura)
Task 3 (Dockerfile)  ─┐
Task 4 (endurecer)  ──┼→  Task 5 (GHCR)  →  Task 6 (supply chain)
                       └→  Task 7 (release)  →  Task 8 (fechamento)
```

As Tasks 3 e 4 não dependem de 1 e 2 e podem ser feitas em paralelo com elas.

## Riscos conhecidos

- **Task 1 toca arquivo em disputa.** `pino-http-options.ts`, `app.module.ts` e
  `cache-module-options.ts` tinham alterações não commitadas de outro trabalho quando este plano foi
  escrito. Confirme `git status` limpo nesses caminhos antes de começar; dois conflitos já
  aconteceram por isso.
- **`turbo prune` com pacotes em TypeScript cru.** `@ruguin/env`, `@ruguin/utils` e
  `@ruguin/shared-domain` são consumidos como fonte, enquanto `@ruguin/cache` é buildado. Se o Step 3
  da Task 3 falhar por módulo ausente, é aqui que está a causa.
- **Node 26 excede o suporte declarado do Prisma** (até 24). Funciona hoje, verificado; um upgrade
  de qualquer um dos dois pode quebrar sem aviso.
- **100% é piso para código novo.** Toda regra de negócio futura nasce precisando de teste para
  passar no CI.
