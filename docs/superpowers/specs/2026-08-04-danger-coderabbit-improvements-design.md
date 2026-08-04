# Melhorias no DangerJS e no CodeRabbit — Design

## Contexto

A PR #8 já roda `dangerfile.ts` (coverage, agrupamento de commits por tipo, listagem de
endpoints) e `.coderabbit.yaml` (revisão automática com `path_instructions` para `domain/`,
`application/`, `infra/`, testes, migrations Prisma, workflows do GitHub). A review real do
CodeRabbit na PR #8 (22 achados) revelou duas lacunas concretas:

1. **`dangerfile.ts` não cobre nada além de coverage/commits/endpoints** — nenhuma verificação de
   higiene de PR (gif, `.only`/`.skip` esquecido, TODOs novos) nem anotação inline de lint.
2. **`.coderabbit.yaml` não tem `path_instructions` para `infrastructure/terraform/**` nem
   `infrastructure/k8s/**`** — por isso a review real re-levantou dois pontos já decididos
   deliberadamente neste projeto (o endpoint OTLP com `/v1/traces`, correto por como
   `create-tracing-sdk.ts` usa a URL; e uma sugestão de pinagem de módulo Terraform por SHA que
   nem se aplica a módulos de registry, per o próprio escopo documentado do Checkov CKV_TF_1).

## Decisões

### 1. GIF na descrição da PR — reimplementado, não instalado

O pacote pedido originalmente (`danger-gif`) não existe no npm. O real é `danger-plugin-gifs`
(2019, ~20 linhas, verificado lendo o código-fonte no GitHub): checa se `danger.github.pr.body`
contém a substring `.gif`; se não tiver, posta uma mensagem informativa com um gif triste fixo do
Giphy como fallback. Carrega uma dependência `eslint@^6.0.1` sem motivo aparente para o que faz, e
não teve release desde então.

Decisão: reimplementar a mesma lógica direto em `dangerfile.ts` (~10 linhas), sem instalar o
pacote — evita depender de algo parado há anos e a dependência estranha, mantendo o mesmo
comportamento (nudge informativo, nunca bloqueia).

### 2. `danger-plugin-no-test-shortcuts` — instalado

Verificado real e mantido (`danger-plugin-no-test-shortcuts` no npm, lendo o README direto).
Hoje nada no ESLint deste projeto bloqueia `.only(`/`.skip(` em arquivos de teste — um desses
esquecido silenciosamente reduz a suíte que o CI roda, sem nenhum aviso. Rede de segurança real,
sem sobreposição com nada que já existe.

A API real exige um `testFilePredicate` (a função não assume nenhuma convenção de nome sozinha) e
tem `.skip()` como **`ignore` por padrão** — sem setar `skippedTests: 'fail'` explicitamente, um
`.skip()` esquecido passaria batido, contrariando o motivo de instalar isto:

```ts
noTestShortcuts({
  testFilePredicate: (filePath) => /\.(unit|int|e2e)\.ts$/.test(filePath),
  skippedTests: 'fail'
})
```

### 3. `danger-plugin-todos` — instalado

Verificado real e mantido, lendo o README direto. Lista TODO/FIXME novos adicionados no diff como
bloco informativo, mesmo padrão visual das seções existentes do `dangerfile.ts`. É uma tarefa
assíncrona — a chamada precisa passar por `schedule()`, do próprio `danger` (confirmado no
exemplo de uso do README, não presumido).

### 4. `danger-plugin-lint-report` — instalado, com passo novo no CI

Verificado real e mantido (v1.8.1, 15 releases). Lê relatórios Checkstyle XML e posta os
problemas como comentários inline, na linha exata do diff (`requireLineModification: true`), com
a severidade do ESLint decidindo se vira `message`/`warn`/`fail` (`reportSeverity: true`).

O ESLint 10 deste projeto não traz mais o formatter `checkstyle` embutido (confirmado rodando
`eslint --help` neste ambiente — só restam `stylish`, `json`, `json-with-metadata`, `html`).
Precisa de `eslint-formatter-checkstyle` (verificado real e mantido, zero dependências,
republicação oficial dos formatters que o ESLint removeu).

`ci.yml` ganha um passo novo entre `Check (types, lint, format, spelling)` e `Test`, que roda o
ESLint de novo só para gerar o relatório (não recheca se passa — isso já aconteceu no passo
anterior):

```yaml
- name: Generate ESLint checkstyle report (for Danger)
  if: always() && github.event_name == 'pull_request'
  run: pnpm exec turbo run check:lint -- --format checkstyle --output-file eslint-checkstyle-report.xml
  continue-on-error: true
```

`if: always()` porque mesmo se o `Check` já falhou, ainda quero o relatório gerado — é justamente
quando ele mais ajuda (mostrar onde, não só que falhou). `continue-on-error: true` pelo mesmo
motivo do passo do Danger existente: gerar relatório não deve derrubar o job por conta própria.

Também precisa de uma entrada nova em `.gitignore` (`eslint-checkstyle-report.xml`) — hoje só
`coverage` está ignorado; sem isso, o relatório aparece como arquivo sujo em qualquer checkout
local onde alguém rode o comando de lint com `--format checkstyle`.

### 5. `dangerfile.ts` — integração final

```ts
import { schedule } from 'danger'
import noTestShortcuts from 'danger-plugin-no-test-shortcuts'
import todos from 'danger-plugin-todos'
import lintReport from 'danger-plugin-lint-report'

noTestShortcuts({
  testFilePredicate: (filePath) => /\.(unit|int|e2e)\.ts$/.test(filePath),
  skippedTests: 'fail'
})

// todos() and lintReport.scan() are both async — schedule() is danger's own hook for that,
// confirmed from each plugin's own README usage example, not assumed.
schedule(todos())
schedule(
  lintReport.scan({
    fileMask: '**/eslint-checkstyle-report.xml',
    reportSeverity: true,
    requireLineModification: true
  })
)

function gifSection(): string {
  const hasGif = /\.gif/.test(danger.github.pr.body ?? '')
  if (hasGif) return ''
  return '⚠️ Essa PR não tem gif na descrição. Considere adicionar um.'
}

const sections = [coverageSection(), featuresSection(), endpointsSection(), gifSection()].filter(
  (section) => section !== ''
)
if (sections.length > 0) markdown(sections.join('\n\n'))
```

### 6. `.coderabbit.yaml` — `path_instructions` para infraestrutura

Dois blocos novos, documentando convenções já decididas neste projeto para o CodeRabbit parar de
re-levantar os mesmos pontos em toda PR futura que toque essas pastas:

```yaml
- path: 'infrastructure/terraform/**'
  instructions: >-
    Module sources here are registry-sourced (terraform-aws-modules/*, version constraints), not
    git-sourced — Checkov's CKV_TF_1 (commit-SHA pinning) only applies to git:: sources per its
    own documented scope, so don't flag registry version constraints under that rule.
    OTEL_EXPORTER_OTLP_ENDPOINT intentionally includes the full /v1/traces path: core-server's
    create-tracing-sdk.ts passes it straight through as OTLPTraceExporter's `url`, which is used
    as-is (no auto-suffixing) — only unset `url` triggers the SDK's own auto-append behavior.
    Kubernetes resources belong in the core-server namespace, not default. Secrets intentionally
    live in Terraform state via kubernetes_secret, not an External Secrets Operator — a documented
    tradeoff (see docs/superpowers/specs/2026-08-03-production-eks-observability-design.md
    Decision 10), not an oversight to re-flag every PR.

- path: 'infrastructure/k8s/**'
  instructions: >-
    Resources belong in the core-server namespace, not default. TLS termination on the public NLB
    and immutable release tags on the Deployment's image are known, documented gaps (need an ACM
    cert/domain and a release-promotion pipeline that don't exist yet) — flag once per gap is
    enough, this doesn't need repeating on every PR that touches these files.
```

### 7. `.coderabbit.yaml` — ajuste em `path_filters`

Adiciona `'!infrastructure/terraform/**/.terraform.lock.hcl'`, mesmo padrão já usado para excluir
`pnpm-lock.yaml` — lockfile gerado, não vale revisão linha a linha.

## Riscos

- **`danger-plugin-lint-report` depende de um passo novo no CI rodar antes do Danger.** Se a
  ordem dos passos em `ci.yml` mudar no futuro sem manter essa dependência, o Danger roda sem
  relatório e a seção de lint fica silenciosamente vazia (não quebra nada, só perde a anotação
  inline) — `fileMask` sem match nenhum é um no-op para este plugin, confirmado lendo seu
  comportamento documentado.
- **`eslint-formatter-checkstyle` é uma republicação não-oficial** de um formatter que o próprio
  ESLint removeu do core — mantido por uma organização terceira (`fregante/eslint-formatters`),
  não pelo time do ESLint. Baixo risco (zero dependências, formato Checkstyle é estável há anos),
  mas vale registrar que não é 100% "oficial".
- **`danger-plugin-no-test-shortcuts` pode gerar falso positivo** se algum dia um `.skip(` for
  usado deliberadamente e documentado (ex: teste temporariamente desabilitado com issue linkada).
  Não há mecanismo de exceção conhecido no plugin — se isso virar necessário, a solução é remover
  a chamada `noTestShortcuts()` para aquele caso específico via revisão manual, não configuração.

## Resultado

_(preenchido depois da implementação)_
