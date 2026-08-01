# Gate de análise completa (GitNexus + ruflo + code review) antes de todo commit — Design

**Data:** 2026-07-31
**Status:** Implementado (`packages/precommit-checks`, `.husky/pre-commit`, `.claude/settings.json`, `scripts/claude-git-commit-hook.cjs`) — verificado ponta a ponta via commits reais. Limitação conhecida: os checks do GitNexus (cycle/detect-changes/impact) degradam para warning quando há múltiplos worktrees do mesmo repo indexados simultaneamente (ambiguidade de nome no GitNexus) — a lógica de detecção em si foi validada diretamente com `-r`, mas o script não passa esse parâmetro hoje.
**Escopo:** `.husky/pre-commit`, `.claude/settings.json`, novos `scripts/*.mjs` na raiz do monorepo.

## Contexto e objetivo

Hoje, `CLAUDE.md` pede em prosa para o Claude Code rodar `detect_changes()` do GitNexus antes de commitar — mas prosa em `CLAUDE.md` não é uma garantia: nesta mesma sessão, edições feitas ali foram silenciosamente revertidas por outro processo. `.husky/pre-commit` só roda `lint-staged` (eslint/prettier/vitest related); não há GitNexus, `ruflo analyze` nem code review em nenhum lugar do pipeline, nem local nem em CI.

O objetivo é garantir que **todo commit** — feito pelo Claude Code ou diretamente pelo usuário no terminal — passe por três pilares antes de ser aceito: análise estrutural (GitNexus), análise de código (ruflo, suíte completa) e code review. A garantia precisa sobreviver a reinício de sessão, compactação de contexto, ou `CLAUDE.md` sendo reescrito — ou seja, não pode depender só de o Claude "lembrar" de rodar isso.

## Fora de escopo

- Mudanças no `ci.yml` (já roda build/check/test; fora do escopo deste design).
- Corrigir retroativamente a dívida técnica já existente no repo (ex.: os 20 arquivos já flagados por `ruflo analyze complexity`, todos em `.claude/helpers/*.cjs`) — o baseline nasce do estado atual do repo, não de zero.
- Novas dependências npm — os scripts usam só `node:child_process`, `node:crypto`, `node:fs` (nativos).
- Qualquer análise disparada por edição de arquivo ou fim de sessão — o gatilho é exclusivamente "antes de `git commit`".

## Arquitetura

Duas camadas de enforcement compartilhando uma única lógica determinística:

```
scripts/pre-commit-checks.mjs        ← fonte única: GitNexus + ruflo (determinístico, suíte completa, paralelo)
        ↑                                    ↑
.husky/pre-commit                    scripts/claude-precommit-gate.mjs   ← só usado pelo hook do Claude
   (todo commit, incl. os do                 ↑
    usuário via terminal)             .claude/settings.json → PreToolUse(Bash, detecta `git commit`)
                                              ↑
                                       scripts/mark-review-done.mjs   ← Claude chama depois do review agentic
```

Hooks do Claude Code são scripts de shell — não conseguem, sozinhos, decidir "rodar um agente de review". Por isso o gate do lado Claude não tenta ser inteligente: ele só compara o hash do diff staged atual contra um arquivo de estado local (`.git/.claude-precommit-state.json`, nunca versionado — vive dentro de `.git/`, que já não é rastreado pelo git). Isso faz o enforcement sobreviver a qualquer coisa que aconteça com o contexto da conversa ou com `CLAUDE.md`: o hook bloqueia e diz o que falta, mecanicamente, toda vez que o Claude tentar `git commit`.

O code review agentic só roda do lado Claude — nunca via `claude -p` dentro do Husky, o que seria lento e gastaria tokens em todo commit de qualquer pessoa.

## Componentes

### `scripts/pre-commit-checks.mjs` (determinístico, compartilhado pelos dois lados)

Roda em paralelo (`Promise.all`), escopado ao `git diff --cached`:

**Gate binário (zero-tolerance — qualquer achado bloqueia sempre):**
| Comando | Bloqueia quando |
|---|---|
| `node .gitnexus/run.cjs check --cycles` | novo ciclo de import encontrado |
| `node .gitnexus/run.cjs detect-changes --scope staged` | risco retornado é `HIGH`/`CRITICAL` |
| `node .gitnexus/run.cjs impact <symbol> -d upstream --summary-only` (por símbolo mudado, do passo anterior) | qualquer símbolo com risco `HIGH`/`CRITICAL` |
| `ruflo security secrets --action scan -p .` | qualquer secret encontrado |
| `ruflo analyze diff --risk` | risco geral ≠ `low` |

**Gate por regressão (bloqueia só se piorar vs. baseline, olhando só os arquivos tocados pelo diff):**
| Comando | Bloqueia quando |
|---|---|
| `ruflo analyze complexity` | cyclomatic **ou** cognitive de um arquivo tocado subiu vs. `.claude/pre-commit-baseline.json` (qualquer um dos dois já bloqueia) |
| `ruflo analyze dependencies` | nº de conexões de um arquivo tocado subiu vs. baseline |

**Report-only (nunca bloqueia sozinho — sem baseline confiável: clustering pode mudar por motivos alheios à qualidade do código):**
`ruflo analyze symbols`, `imports`, `boundaries`, `modules`, `ast`, `deps`. Viram artifact (`.git/.claude-precommit-report.json`) que alimenta o code review agentic como contexto — nada do que é computado é descartado.

Tratamento de "ferramenta indisponível" (ex.: o erro de índice FTS corrompido do GitNexus visto nesta sessão, ou `npx` sem rede): vira `⚠ warn`, não conta como achado — só resultado real de uma ferramenta que rodou bloqueia.

Ao final: se PASS, atualiza `.claude/pre-commit-baseline.json` (complexidade/conexões dos arquivos tocados) e roda `git add .claude/pre-commit-baseline.json` — mesmo padrão que o `lint-staged` já usa hoje para reincluir arquivos modificados pelo próprio hook. Escreve o report completo em `.git/.claude-precommit-report.json` e imprime `PRECOMMIT_RESULT=PASS` ou `PRECOMMIT_RESULT=FAIL` como última linha de stdout.

Exit code: `0` = pass, `1` = achado bloqueante, `2` = erro interno do script (tratado como falha por segurança).

### `.husky/pre-commit`

Adiciona `node scripts/pre-commit-checks.mjs || exit 1` depois do `pnpm exec lint-staged` já existente. Roda para qualquer commit, seu ou do Claude — é a rede de segurança que pega o que escapar do lado Claude.

### `.claude/settings.json` → novo `PreToolUse` (matcher `Bash`)

Só age quando o comando corresponde a `git commit`. Chama `scripts/claude-precommit-gate.mjs`, que:

1. Calcula `diffHash = sha256(git diff --cached)`.
2. Lê `.git/.claude-precommit-state.json` (estado vazio se ausente/corrompido — tratado como "sem gate", refaz do zero).
3. Se `state.diffHash !== diffHash` → roda `pre-commit-checks.mjs` fresco, grava o resultado no state (`deterministic: 'pass'|'fail'`, `agenticReviewDone: false`, `overrideApproved: false`, mantendo o `diffHash` novo).
4. `deterministic === 'fail'` → nega o `git commit` (o hook devolve os achados do report como motivo).
5. `deterministic === 'pass'` e nem `agenticReviewDone` nem `overrideApproved` → nega o `git commit`, com instrução: "rode um agente de code review sobre o diff staged (contexto: `.git/.claude-precommit-report.json`), resolva os achados ou peça confirmação ao usuário, depois rode `mark-review-done.mjs`".
6. Senão → permite.

### `scripts/mark-review-done.mjs [--override "<motivo>"]`

Chamado pelo Claude depois de rodar o review agentic (agente `code-reviewer` sobre `git diff --cached`, com o report determinístico como contexto extra). Recalcula o `diffHash` atual e grava `agenticReviewDone: true` no state (e `overrideApproved: true` + `overrideReason` se `--override`). **A flag `--override` só é usada depois de o achado ser mostrado ao usuário e ele confirmar explicitamente, no mesmo turno, que quer prosseguir mesmo assim** — mesma regra que já vale hoje para `--no-verify`/force-push; o Claude nunca decide isso sozinho.

### `.claude/pre-commit-baseline.json` (versionado)

```json
{
  "updatedAt": "2026-07-31T00:00:00.000Z",
  "complexity": { "<path/relativo>": { "cyclomatic": 0, "cognitive": 0 } },
  "dependencies": { "<path/relativo>": { "connections": 0 } }
}
```

Primeira execução (arquivo ausente): trata todo arquivo como "sem baseline" → gate de regressão sempre passa nessa primeira vez, e o arquivo é criado com o estado atual.

## Fluxo (commit feito pelo Claude)

```
Claude tenta `git commit` → PreToolUse dispara claude-precommit-gate.mjs
  → determinístico falhou? → nega, Claude corrige e tenta de novo (novo diff → novo hash → refaz do zero)
  → determinístico passou, review pendente? → nega, Claude roda o agente de review
      → review não achou nada → mark-review-done.mjs → retenta `git commit` → passa
      → review achou algo → Claude PARA, mostra pro usuário
          → usuário pede correção → Claude corrige (diff muda, ciclo recomeça sozinho)
          → usuário confirma "comita assim mesmo" → mark-review-done.mjs --override "<motivo>" → retenta → passa
  → tudo ok → git commit roda normalmente → Husky roda pre-commit-checks.mjs de novo (idempotente, mesmo diff = mesmo resultado) → commit efetivado
```

Commit feito direto pelo usuário no terminal: só passa pelo `.husky/pre-commit` (gate binário + regressão; sem o review agentic, que só existe do lado Claude).

## Tratamento de erros

- Ferramenta (GitNexus/ruflo) indisponível ou com erro de infraestrutura (rede, índice corrompido) → `⚠ warn`, não conta como achado bloqueante.
- `.git/.claude-precommit-state.json` corrompido/ilegível → tratado como ausente, refaz os checks do zero (fail-safe = mais rigoroso, nunca deixa passar por engano).
- Índice do GitNexus nunca gerado (clone novo) → warn "rode `node .gitnexus/run.cjs analyze`", pula os checks de grafo — o hook não tenta indexar sozinho (pode ser lento ou falhar sem rede).
- `.claude/pre-commit-baseline.json` ausente na primeira execução → tratado como "sem dado prévio", nunca bloqueia por regressão nessa primeira vez; arquivo é criado.
- Script `pre-commit-checks.mjs` crasha (exceção não tratada) → exit code `2`, tratado como falha (mesmo comportamento de "determinístico falhou").

## Estratégia de testes

- `scripts/__tests__/pre-commit-checks.unit.ts` — testa as funções puras de parsing/decisão (ex.: "dado este JSON de saída do `gitnexus detect-changes`, o risco é HIGH → deve bloquear"; "dado este `complexity` com um arquivo tocado acima do baseline → deve bloquear") usando saída canned das CLIs, sem chamar `gitnexus`/`ruflo` de verdade.
- `scripts/__tests__/claude-precommit-gate.unit.ts` — testa a máquina de estados do gate (hash bate/não bate, `agenticReviewDone`, `overrideApproved`) com um `state` mockado.
- Plano manual, antes de considerar a implementação pronta:
  1. Introduzir um ciclo de import proposital, `git add`, `git commit` → confirma bloqueio via Husky.
  2. Commit limpo (sem achados) → passa nos dois lados.
  3. No lado Claude: tentar `git commit`, confirmar que o hook nega pedindo review; rodar o agente, `mark-review-done.mjs`, confirmar que o retry passa.
  4. Achado do review agentic → confirmar que o Claude para e pergunta antes de qualquer `--override`.
  5. Piorar a complexidade de um arquivo já no baseline → confirmar bloqueio por regressão; reverter → confirma que passa.

## Decisões em aberto para a próxima fase (não bloqueiam este design)

- Se a suíte completa em paralelo ainda assim ficar lenta demais na prática (dezenas de segundos por commit), pode valer revisitar para o modo "gate rápido bloqueia na hora, suíte pesada roda em background" descartado nesta sessão — decisão adiada até haver medição real de uso.
- Regras de regressão hoje cobrem só `complexity` e `dependencies`; se `boundaries`/`modules` amadurecerem um baseline confiável no futuro, podem virar gate de regressão também.
