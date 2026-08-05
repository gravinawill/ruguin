# DevOps Onda 1 — Do código ao artefato assinado — Design

**Data:** 2026-08-02
**Escopo:** `apps/core-server` (Dockerfile), `.github/workflows`, configuração de cobertura e release
**Custo de cloud:** zero

## Contexto

O repositório tem uma base de qualidade acima do comum para o estágio: CI com tipos, lint, formato,
ortografia e 365 testes em três camadas; gitleaks; Dependabot; commitlint com husky e lint-staged;
CodeRabbit revisando PR. O que falta é tudo que acontece **depois** do merge — nada do que foi
construído sai da máquina de quem desenvolve, porque **não existe imagem**.

O objetivo declarado é uma plataforma DevOps completa, com IaC, GitOps sobre EKS/ArgoCD e uma
segunda nuvem (GCP) com propósito de portfólio. Esse alvo foi decomposto em quatro ondas; esta é a
primeira e a única que não depende de nenhuma decisão de nuvem — seu resultado continua válido se o
destino mudar.

Estado relevante: **um** dos seis serviços do product-spec existe (`core-server`), e o produto ainda
não envia email (EMAIL-4 e EMAIL-5 pendentes). O que for implantado nas ondas seguintes é um serviço
que responde `/health` e `/docs`, não o produto.

## Objetivo

Produzir, a cada merge, um artefato de container versionado, rastreável até o commit, verificado
quanto a vulnerabilidades e assinado — e fechar as lacunas do CI atual que enfraquecem essa cadeia.

## Decisões

### 1. Testabilidade antes de threshold

`createPinoHttpOptions` recebia o ambiente por parâmetro e passou a ler `serverENV` direto. A
intenção está correta — `@ruguin/env` é o único lugar autorizado a ler `process.env` — mas remover o
parâmetro removeu junto o ponto de injeção, e os testes que passavam `{ NODE_ENV: 'production' }`
deixaram de compilar essa possibilidade. Sete testes ficam vermelhos.

A correção devolve a injeção mantendo o env tipado: a função recebe o objeto de ambiente com valor
padrão vindo de `serverENV`, de modo que produção usa o env validado e o teste passa o seu.

Isto vem antes de qualquer meta de cobertura porque nenhum threshold é alcançável sobre código que
só funciona com o ambiente global montado.

**Este arquivo está sendo editado por outro trabalho em andamento.** A implementação deste item
espera aquele commit; o restante da onda não depende dele.

### 2. Cobertura: 100% do código de negócio, com exclusões versionadas

A meta é 100%, com exclusões explícitas e justificadas no `vitest.config.ts`:

| Excluído | Por quê |
|---|---|
| `**/generated/**` | client do Prisma, ~3 mil linhas por modelo, gerado a cada build |
| `main.ts` | bootstrap; exercitá-lo testa o NestJS, não o serviço |
| `**/*.module.ts` | declaração de providers; um teste aqui afirma que a lista é a lista |
| `**/__tests__/**`, `*.config.ts` | os próprios testes e configuração |

100% literal do repositório obrigaria a escrever testes que exercitam sem afirmar, e o custo recai
na manutenção sem contrapartida. Com as exclusões, o número passa a significar "toda regra de
negócio é coberta", que é a garantia pretendida.

O alvo é 100% sobre o que sobra das exclusões, sem exceção permanente. A linha de base será medida
com a suíte verde — hoje ela está vermelha por causa do item 1, então não há número confiável.

Se a medição mostrar distância, o caminho é escrever os testes que faltam, não baixar o alvo. O
único ajuste permitido é temporal: o threshold pode entrar num valor intermediário e subir em
degraus, desde que cada degrau esteja registrado no `vitest.config.ts` com a data e o que falta
cobrir. Baixar o threshold para fazer o CI passar é proibido — nesse caso a mudança é que está
incompleta.

As três camadas contam para a cobertura: `.unit.ts`, `.int.ts` e `.e2e.ts`.

### 3. Dockerfile multi-stage sobre Alpine

```
pruner   turbo prune @ruguin/core-server --docker
builder  pnpm install --frozen-lockfile · prisma generate · pnpm build
runner   node:26.5.1-alpine · usuário não-root · dist + deps de produção
```

`turbo prune` recorta o monorepo para o subconjunto que este app precisa, e o lockfile parcial que
ele emite preserva o `--frozen-lockfile`.

**Alpine é seguro no runtime**, e isso foi verificado e não presumido: o client gerado pelo Prisma 7
não contém `.node` nem `.wasm`. O query compiler com `@prisma/adapter-pg` fala com o Postgres por
JavaScript puro, então não há binário nativo em execução e a diferença musl/glibc deixa de importar.
O `schema-engine`, esse sim nativo, só participa do `prisma generate` e fica no builder — onde
`openssl` e `libc6-compat` precisam estar instalados.

**`tini` como PID 1.** `main.ts` chama `enableShutdownHooks()` e `PrismaService.onModuleDestroy`
fecha a conexão. Node como PID 1 não encaminha sinais da forma que o orquestrador espera, e sem isso
um SIGTERM encerra o processo com a conexão aberta em vez de desligar com ordem.

O `.dockerignore` exclui `node_modules`, `dist`, `coverage` e `.git` — sem ele o contexto de build
carrega o monorepo inteiro e o cache de layer nunca acerta.

### 4. Publicação: GHCR, multi-arquitetura

Registro no **GHCR**: gratuito para repositório público e sem exigir credencial de nuvem, o que
mantém esta onda independente da Onda 2. Se a Onda 2 preferir ECR, a replicação é um passo a mais,
não uma reescrita.

Build para `linux/amd64` e `linux/arm64` — o desenvolvimento acontece em Apple Silicon e o destino
provável é amd64; descobrir essa diferença no primeiro deploy é evitável.

Tags: `sha-<commit>` sempre, `<semver>` em release, `latest` apenas no branch default.

### 5. Cadeia de suprimentos da imagem

As ferramentas de hoje cobrem o **código** (gitleaks, Dependabot, semgrep, `minimumReleaseAge`).
Nenhuma cobre a **imagem**:

- **SBOM** com Syft, anexado ao release
- **Scan** com Trivy, reprovando em HIGH e CRITICAL
- **Assinatura** com cosign em modo keyless, usando o OIDC do GitHub — sem chave privada para
  guardar ou rotacionar
- **Proveniência** SLSA emitida pelo buildx

### 6. `semantic-release`

Versão, tag, changelog e release do GitHub derivados dos commits, que já seguem Conventional
Commits por força do commitlint. A imagem recebe a tag semver no mesmo passo.

### 7. Endurecer o CI existente

Três lacunas concretas:

- **Actions referenciadas por tag** (`actions/checkout@v4`): uma tag pode ser movida para outro
  commit, e é assim que um pipeline é comprometido sem que nada no repositório mude. Passam a ser
  fixadas por SHA, com o Dependabot mantendo-as atualizadas.
- **Sem `permissions:` declarado**: o `GITHUB_TOKEN` chega com escopo padrão amplo. Cada workflow
  passa a declarar o mínimo, e os jobs que assinam recebem `id-token: write`.
- **`test:coverage` mede e não reprova** — resolvido pela decisão 2.

## Fora de escopo

- Terraform, EKS, ArgoCD, GCP — Ondas 2 e 4.
- Observabilidade em produção — Onda 3. A stack em `infrastructure/local/` é declarada no
  product-spec como "estritamente local/dev, não produção".
- Dockerfile dos outros cinco serviços do product-spec: eles não existem.
- Backup, DR e runbooks — Onda 4.

## Riscos

- **Conflito com trabalho em andamento.** `pino-http-options.ts`, `app.module.ts` e
  `cache-module-options.ts` têm alterações não commitadas de outro trabalho. Dois conflitos já
  ocorreram hoje por essa razão. O item 1 espera; o resto da onda toca arquivos que não estão em
  disputa.
- **100% é um piso alto para código novo.** Toda futura regra de negócio nasce precisando de teste
  antes de passar no CI. É o efeito pretendido, mas muda o ritmo de quem escreve.
- **`turbo prune` com pacotes em TypeScript cru.** `@ruguin/env`, `@ruguin/utils` e
  `@ruguin/shared-domain` são consumidos como fonte; `@ruguin/cache` passou a ser buildado. O recorte
  precisa preservar essa distinção, e é o ponto mais provável de falha do Dockerfile na primeira
  tentativa.
- **Node 26 é recente.** O `preinstall` do Prisma declara suporte até 24; funciona hoje, verificado,
  mas um upgrade de qualquer um dos dois pode quebrar sem aviso.

## Resultado

`pnpm run check`, `pnpm build` e `npx turbo test:all` passam limpos (7/7, 7/7, 5/5). A imagem final
(`node:26.5.1-alpine`, com `pino-pretty` incluído) tem **183,5 MB**, confirmado via `docker inspect
--format='{{.Size}}'` — o `docker images` chegou a reportar 891 MB para a mesma imagem por conta de
como o containerd store do buildx soma blobs de atestação; o número de `docker inspect` é o real.

### Cobertura efetivamente aplicada

Nenhum pacote chegou a 100% em todas as quatro métricas na primeira medição; cada threshold é o
degrau medido, registrado no próprio `vitest.config.ts` do pacote — não um valor arbitrário nem uma
promessa futura sem data:

| Pacote | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `@ruguin/cache` | 83 | 75 | 79 | 91 |
| `@ruguin/core-server` (unit) | 91 | 93 | 87 | 92 |
| `@ruguin/env` | 83 | 75 | 90 | 83 |
| `@ruguin/shared-domain` | 96 | 78 | 100 | 100 |
| `@ruguin/utils` | 100 | 100 | 100 | 100 |

`@ruguin/core-server`'s `test:cov` cobre só o project `unit` — `integration` e `e2e` seguem fora do
gate de cobertura porque dependem de Postgres e Valkey vivos, que a máquina de quem desenvolve tem
via `docker compose` mas o script de cobertura, sozinho, não garante.

### Decisões do plano que a implementação precisou mudar

- **`pnpm deploy --prod --legacy`.** A flag `--legacy` não estava na Decisão 3; sem ela o `pnpm
  deploy` desta versão rejeita o layout do workspace.
- **Task 3.5, não prevista.** `@ruguin/env`, `@ruguin/utils` e `@ruguin/shared-domain` (então
  `ddd-kernel`) eram consumidos como fonte (`./src/index.ts`). Isso funciona por acidente via
  symlink do pnpm em desenvolvimento, mas `pnpm deploy` materializa arquivo real dentro de
  `node_modules`, e Node recusa type-stripping de `.ts` ali — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
  Os três passaram a ser buildados com `tsdown`, no mesmo padrão que `@ruguin/cache` já usava.
- **`test:coverage` era gate morto.** O vitest do workspace raiz não propaga `test.projects`
  aninhados nem os thresholds de cada pacote — `turbo run test:cov` por pacote resolveu, e cada
  configuração local passou a valer de fato.
- **CI nunca provisionava Valkey.** O gate de cobertura de `@ruguin/cache` mede unit e integration
  juntos por design (é como o driver Valkey é exercitado), mas o `ci.yml` nunca subia um Valkey para
  os testes de integração se conectarem — a primeira execução real, após o fix do gate morto acima,
  falhou com `Cache connection failed`. `ci.yml` sobe master + réplica via `docker run` direto (o
  bloco `services:` do GitHub Actions não tem campo para sobrescrever o comando do container, que a
  réplica precisa via `--replicaof`), com espera pelo link de replicação, não só `PONG`.
- **QEMU quebrava `prisma generate` no cross-build.** A primeira publicação real revelou que
  cross-buildar `linux/arm64` no runner amd64 corrompe o stdout do `schema-engine` nativo sob
  emulação (`Unable to parse JSON [Context: getDmmf]`). Como o `core-server` não tem nenhuma
  dependência nativa em produção (verificado com `pnpm deploy --prod`), as etapas `pruner` e
  `builder` do Dockerfile passaram a fixar `--platform=$BUILDPLATFORM`: rodam uma vez, nativas, e só
  a etapa final cruza arquitetura.
- **`pino-pretty` faltava em produção.** `createPinoHttpOptions` pede esse transport sempre que
  `ENVIRONMENT !== 'production'`, mas o pacote vivia em `devDependencies` — qualquer ambiente não-
  produção (staging, local) quebrava o boot com `unable to determine transport target for
  "pino-pretty"`. Reproduzido rodando a imagem com `ENVIRONMENT=local`, o mesmo cenário do critério
  de aceite da Task 3.5. Movido para `dependencies`; sem binário nativo, não reabre o problema do
  item anterior.
