# PR Quality Reporting — Design

**Data:** 2026-08-03
**Escopo:** `.github/workflows`, `dangerfile.ts`, `sonar-project.properties`, `vitest.config.ts` de cada pacote com cobertura
**Custo de cloud:** zero — SonarCloud e Semgrep AppSec Platform são grátis para repositório público; CodeQL é nativo do GitHub.

## Contexto

A Onda 1 (`docs/superpowers/specs/2026-08-02-devops-artifact-pipeline-design.md`) fechou o que acontece
**depois** do merge: imagem assinada, escaneada, publicada. O que falta agora é enriquecer o que o
revisor vê **durante** o PR, antes de decidir aprovar — hoje só `ci`, `image`, `gitleaks` e CodeRabbit
aparecem, e nenhum deles resume cobertura, o que mudou em termos de negócio, quais endpoints existem,
nem cobre SAST/SCA no momento do PR (o Trivy de hoje só escaneia a imagem, depois do merge).

## Objetivo

Um comentário único e legível no PR com cobertura, features implementadas (por Conventional Commit) e
endpoints da API; mais uma segunda camada de análise estática e de dependências, rodando **no PR**, com
motores diferentes dos que já existem (CodeRabbit é revisão por LLM; nenhuma das ferramentas novas
sobrepõe o que ela faz).

## Decisões

### 1. `dangerfile.ts` na raiz — um comentário só

Novo devDependency `danger` no root `package.json`. Novo step `Danger` em `.github/workflows/ci.yml`,
depois do step `Test`, com `if: always() && github.event_name == 'pull_request'` (comenta mesmo se o
`Test` falhar, com o que estiver disponível) e `run: npx danger ci`, usando
`DANGER_GITHUB_API_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. O job `ci` ganha `pull-requests: write` (mesma
lacuna que o gitleaks já expôs em `release-image.yml`: sem essa permissão, Danger recebe 403 ao tentar
comentar).

Danger mantém as três seções no mesmo comentário e o atualiza a cada push — é o comportamento nativo
dele, não precisa de nenhuma action de "sticky comment" à parte.

### 2. Cobertura: reportada como texto lido do disco, não como threshold reimportado

Cada `vitest.config.ts` (`packages/{cache,env,shared-domain,utils}` e `apps/core-server`) ganha
`json-summary` na lista `coverage.reporter` (hoje `['text', 'lcov']` nos cinco, sem exceção) — o
vitest passa a escrever `coverage/coverage-summary.json` com `total.{statements,branches,functions,lines}.pct`
por pacote, no mesmo `pnpm test:coverage` que o CI já roda.

O threshold configurado (o "min X" ao lado do número) é lido pelo Dangerfile **como texto puro** do
próprio `vitest.config.ts` — uma expressão regular simples sobre o bloco `thresholds: { ... }`, sem
importar ou executar o arquivo. Importar um `vitest.config.ts` de dentro do Dangerfile encadearia a
resolução de módulos do vitest no ambiente de execução do Danger, o que é frágil e desnecessário para
extrair quatro números; ler como texto é o mesmo truque usado para escrever a seção `## Resultado` da
Onda 1 manualmente.

A tabela é só relatório — quem reprova o build por cobertura insuficiente continua sendo o próprio
`vitest` (o `test:coverage` já falha antes de o Danger rodar). Se um pacote não tiver
`coverage-summary.json` (por exemplo, o `test:cov` falhou antes de gerar saída), a linha desse pacote
é omitida, não gera erro no Dangerfile.

**Resultado de execução dos testes (não só cobertura) também vai para o Sonar.** `coverage.reporter`
e `sonar.javascript.lcov.reportPaths` dizem ao Sonar *quanto* do código foi exercitado; não dizem
*quantos testes passaram, falharam ou foram pulados* — esse é um relatório diferente, que o Sonar lê
do formato "Generic Test Execution". Cada `vitest.config.ts` ganha `vitest-sonar-reporter` na lista
de nível superior `reporters` (hoje `['verbose']` nos cinco, sem exceção), escrevendo
`coverage/sonar-report.xml`; `sonar-project.properties` aponta para os cinco arquivos via
`sonar.testExecutionReportPaths`, no mesmo formato de lista que `lcov.reportPaths` já usa.

### 3. Features: agrupadas por Conventional Commit

`danger.git.commits` já traz todos os commits do PR. Um regex sobre o prefixo (`feat`, `fix`, `docs`,
`refactor`, `test`, `chore`, `ci`, `perf`, `build`) — o mesmo formato que o commitlint já obriga —
agrupa em seções Markdown. Commits de merge (sem esse prefixo) são ignorados.

### 4. Endpoints: varredura estática de decorators, sem subir a aplicação

Gerar o documento OpenAPI de verdade exigiria instanciar o `AppModule` inteiro, e
`OutboxModule.forRoot()` roda manutenção de partição contra um Postgres real já na inicialização (não
é lazy — confirmado rodando a imagem localmente hoje). Depender disso custaria subir Postgres também
neste step, só para uma tabela de `Método | Path` — desproporcional.

Em vez disso, um script pequeno percorre `apps/*/src/**/*.controller.ts`, lê o prefixo de cada
`@Controller('prefixo')` e o path de cada `@Get/@Post/@Put/@Patch/@Delete('path')` via expressão
regular sobre o texto do arquivo — puramente estático, não depende de nenhuma infraestrutura. Hoje só
existe `apps/core-server`, mas o glob já cobre futuros serviços do product-spec sem mudança.

### 5. SonarCloud — Quality Gate bloqueante sobre código novo

Novo `sonar-project.properties` na raiz:

```properties
sonar.projectKey=gravinawill_ruguin
sonar.organization=gravinawill
sonar.sources=apps,packages
sonar.tests=apps,packages
sonar.test.inclusions=**/__tests__/**
sonar.exclusions=**/generated/**,**/dist/**,**/coverage/**,**/*.config.ts,.claude/**
sonar.javascript.lcov.reportPaths=apps/core-server/coverage/lcov.info,packages/cache/coverage/lcov.info,packages/env/coverage/lcov.info,packages/shared-domain/coverage/lcov.info,packages/utils/coverage/lcov.info
sonar.testExecutionReportPaths=apps/core-server/coverage/sonar-report.xml,packages/cache/coverage/sonar-report.xml,packages/env/coverage/sonar-report.xml,packages/shared-domain/coverage/sonar-report.xml,packages/utils/coverage/sonar-report.xml
```

`projectKey` e `organization` vieram da API do SonarCloud (`GET /api/organizations/search`,
`GET /api/projects/search`) depois que a conta e o projeto já existiam — o projeto já tinha uma
análise automática registrada (`lastAnalysisDate` preenchido), o que indica que o GitHub App
provavelmente já está instalado. `.claude/**` entra nas exclusões porque é diretório de scratch de
ferramentas de IA, não código do produto.

Testes vivem misturados com o código-fonte (`src/**/__tests__/**`), não numa pasta `test/` separada
— por isso `sonar.tests` aponta para as mesmas raízes que `sonar.sources`, e `sonar.test.inclusions`
é quem decide, arquivo por arquivo, qual dos dois papéis cada um tem. Sem isso, o Sonar analisaria
teste como se fosse código de produção (métricas de complexidade/duplicação erradas) ou, como na
primeira versão deste documento, deixaria de analisá-lo por completo.

Novo job `sonarqube` em `ci.yml`, com `needs: ci` (baixa a cobertura do job `ci` via
`actions/upload-artifact`/`download-artifact` em vez de rodar `pnpm test:coverage` de novo) e
`fetch-depth: 0` no checkout — o Sonar usa `git blame` para atribuir cada achado a um commit/autor, e
isso exige histórico completo, diferente do checkout raso que `ci` usa hoje.

Dois steps: `SonarSource/sonarqube-scan-action` (análise) e
`SonarSource/sonarqube-quality-gate-action` (espera o resultado do Quality Gate e falha o job se ele
não passar) — sem o segundo, a action de scan só envia os dados; quem decide aprovar ou reprovar é o
SonarCloud, de forma assíncrona, e nada no CI esperaria por essa decisão.

O gate usa **Clean as You Code**: avalia só as linhas que o PR introduziu ou modificou, não a dívida
técnica que já existe no repositório — dívida antiga não passa a bloquear merge do dia para a noite.

### 6. Semgrep — SAST + supply-chain, conta já existe

`gravinawill` já tem uma conta autenticada na Semgrep AppSec Platform (confirmado via
`mcp__plugin_semgrep_guardian__whoami` nesta sessão) — falta só gerar um `SEMGREP_APP_TOKEN` e
registrar como secret. Novo job `semgrep` em `ci.yml`: `semgrep/semgrep-action` (ou `semgrep ci`
direto, via `pip install semgrep` — a decisão entre os dois fica para o plano) rodando os rulesets SAST
e supply-chain/SCA — não o de segredos, que o gitleaks já cobre, para não duplicar achado.

### 7. CodeQL — terceiro motor, zero conta nova

Novo `.github/workflows/codeql.yml`, no padrão que o próprio GitHub gera por padrão:
`github/codeql-action/init` (linguagem `javascript-typescript`), depois `github/codeql-action/analyze`.
Sobe achados nativamente para a aba Security → Code scanning, sem token nenhum além do
`GITHUB_TOKEN` que toda action já recebe.

### 8. Trivy no PR — fecha a lacuna pré-merge

Hoje o Trivy só roda em `release-image.yml`, escaneando a imagem já construída, e só
`if: github.event_name != 'pull_request'` — uma dependência vulnerável introduzida por um PR só é
descoberta depois de já ter sido mergeada. Novo job `trivy-fs` em `ci.yml`, reaproveitando a mesma
`aquasecurity/trivy-action` já usada em `release-image.yml`, mas com `scan-type: fs` sobre a raiz do
repositório em vez de `image-ref` — não depende de build nem de Docker, só do checkout, então roda em
paralelo com `ci` em vez de depois dele.

### 9. actionlint + hadolint

`actionlint` (`rhysd/actionlint`) valida sintaxe e semântica dos arquivos em `.github/workflows/*.yml`
— um novo job leve em `ci.yml`, sem dependência de build. `hadolint` (`hadolint/hadolint-action`)
valida boas práticas do `apps/core-server/Dockerfile` — novo step em `release-image.yml`, antes do
`Build and push`, para falhar rápido sem gastar minutos do build multi-arquitetura caro se o
Dockerfile tiver um problema estrutural.

### 10. SARIF consolidado no GitHub

Achados do Semgrep e do Trivy-fs (formato SARIF, que ambos suportam nativamente) sobem via
`github/codeql-action/upload-sarif` para a mesma aba Security → Code scanning que o CodeQL já usa —
um painel único em vez de três lugares diferentes para olhar.

## Fora de escopo

- Mudar o motor de revisão do CodeRabbit ou duplicar o que ele já faz — as ferramentas novas são
  estáticas/determinísticas, CodeRabbit é revisão por LLM; não se sobrepõem.
- Dashboards ou relatórios fora do GitHub (SonarCloud e Semgrep têm os próprios, usados como estão).
- Aplicar SAST/SCA a serviços que ainda não existem — o `sonar.sources`/glob de endpoints cobre
  `apps/*` e `packages/*` que já existem hoje; novos serviços entram sem mudança de configuração.

## Riscos

- **Branch protection não é automática.** Nenhum desses jobs bloqueia merge só por existir no
  workflow — o GitHub só impede merge de um check que a branch protection de `develop`/`master` lista
  como obrigatório. Adicionar os nomes dos novos jobs/checks à branch protection é um passo manual,
  feito depois que o primeiro PR real confirmar os nomes exatos que cada check reporta.
- **Seis checks novos (mais o comentário do Danger, que não bloqueia) é fricção real.** Cada um pode
  falhar por motivo genuíno (achado real) ou por
  configuração ainda não calibrada (regra ruidosa demais, exclusão faltando). Os primeiros PRs depois
  desta mudança provavelmente vão precisar de ajuste de exclusões/regras — normal, não sinal de que o
  desenho está errado.
- **SHAs de actions novas precisam ser resolvidos na implementação**, não neste documento — o
  princípio de fixar por SHA (Onda 1, Decisão 7) vale para `sonarqube-scan-action`,
  `sonarqube-quality-gate-action`, `codeql-action`, `hadolint-action` também.

## Pré-requisitos externos (só o usuário pode fazer)

1. ~~Criar conta em sonarcloud.io, importar `gravinawill/ruguin` como projeto, instalar o SonarCloud
   GitHub App, gerar um `SONAR_TOKEN`.~~ **Feito** — projeto `gravinawill_ruguin` já existe com análise
   automática registrada; `SONAR_TOKEN` já está registrado como secret do repositório.
2. ~~Gerar um `SEMGREP_APP_TOKEN` na Semgrep AppSec Platform.~~ **Feito** — `SEMGREP_APP_TOKEN` já
   está registrado como secret do repositório.
3. Depois do primeiro PR real com os novos checks: adicionar os nomes exatos que aparecerem em
   Settings → Branches → Branch protection rules, para que passem a bloquear merge de verdade.

## Resultado

`pnpm run check`, `pnpm build` e `pnpm test:coverage` passam limpos (7/7, 7/7, 5/5) com as 8 tasks
de implementação aplicadas. Os três arquivos de workflow (`ci.yml`, `codeql.yml`,
`release-image.yml`) validam como YAML.

### Desvios descobertos durante a implementação

- **`--sarif --output=<path>` estava errado.** A flag real do `semgrep ci` para escrever SARIF em
  arquivo é `--sarif-output`, não uma combinação genérica de `--sarif` com `--output`. Descoberto
  rodando `semgrep ci --help` contra a imagem real, como o próprio plano exigia antes de escrever o
  step — e verificado funcionalmente com um scan de verdade contra um arquivo com uma vulnerabilidade
  conhecida, não só lendo o texto de ajuda.
- **`semgrep/semgrep:1` não existe.** O Docker Hub só publica versões de patch completas para essa
  imagem (`1.172.0` na época da implementação) mais `latest`/`canary` — nenhuma tag de major version
  solta. Corrigido para `semgrep/semgrep:1.172.0`.
- **`hadolint` encontrou 5 achados reais** contra o `Dockerfile` do `core-server` na primeira
  execução: duas versões de pacote `apk` não fixadas (`DL3018`), dois pares de `RUN` consecutivos que
  deveriam ser consolidados (`DL3059`), e o `USER nestjs` sendo um nome em vez de UID numérico
  (`DL3066` — relevante porque `securityContext.runAsNonRoot` do Kubernetes não resolve nome, só
  UID). Todos corrigidos nesta mesma onda, não adiados — incluindo verificar as versões de pacote
  fixadas contra o índice `apk` real da imagem `node:26.5.1-alpine` antes de commitar, e um rebuild
  completo confirmando `uid=1001(nestjs) gid=1001(nodejs)` no container final. O mecanismo
  `--platform=$BUILDPLATFORM` (fix do QEMU, Onda 1) não foi tocado.
- **Erro no próprio plano:** o Step 4 da Task 4 dizia "Expected: OK, 7 properties", mas o
  `sonar-project.properties` especificado no Step 1 do mesmo documento tem 8 linhas — sobrou do
  ajuste tardio que adicionou `sonar.testExecutionReportPaths`. Não afetou a implementação (o
  validador só confirma que cada linha é `chave=valor`, não uma contagem exata), só a expectativa
  documentada estava desatualizada.
- **`vitest-sonar-reporter`'s `outputFile` funcionou de primeira**, sem precisar de ajuste — a
  convenção padrão de reporter do vitest (`outputFile: { '<nome-do-reporter>': '<caminho>' }`) era
  a suposição correta.

### O que ainda depende da primeira execução real em CI

- Os nomes exatos de check que cada job novo reporta no GitHub (para poder adicioná-los à branch
  protection).
- Se o `trivy-fs` encontra alguma vulnerabilidade pré-existente no repositório que precise de
  triagem — o job nunca rodou de verdade, só foi validado sintaticamente.
- Se o step `Danger` (`npx danger ci`, modo que efetivamente posta/atualiza comentário) funciona
  como o `npx danger pr` (modo dry-run, só leitura) já comprovado funcionar — a diferença de modo
  nunca foi exercitada contra um evento `pull_request` real do GitHub Actions.
