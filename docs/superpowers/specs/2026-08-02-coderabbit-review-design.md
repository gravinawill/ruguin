# CodeRabbit — Revisão automática de PR — Design

**Data:** 2026-08-02
**Escopo:** `.coderabbit.yaml` (raiz)

## Contexto

O repo é público em `gravinawill/ruguin`, com branch default `master`. O CI já cobre build, types,
lint, format, spelling e testes; o `security.yml` roda gitleaks. O gate determinístico de
pre-commit foi removido, deixando a revisão no PR como o momento em que convenções de arquitetura
podem ser cobradas.

CodeRabbit é gratuito para repositórios públicos.

## Objetivo

Fazer a revisão automática cobrar o que nenhuma ferramenta deste repo consegue cobrar — as regras
de camada e de estilo que vivem na CLAUDE.md — sem repetir o que o CI já reprova.

## Decisões

### 1. Desligar o que o CI já roda

`eslint`, `biome` e `oxc` ficam desabilitados. O CI reprova o PR quando falham, e um segundo
relatório do mesmo achado é ruído.

`gitleaks` é a única duplicação aceita: secret vazado é irreversível, e o comentário inline no diff
é mais acionável do que uma linha no log do CI.

`languagetool` fica desligado porque a CLAUDE.md raiz está em português e ele produziria correções
gramaticais sobre prosa que não é inglês.

Ligadas, as que cobrem terreno que nenhuma outra ferramenta do repo cobre:

| Ferramenta | O que pega |
|---|---|
| `squawk` | DDL perigoso nas migrations — `DROP COLUMN`, índice sem `CONCURRENTLY`, lock em tabela grande |
| `osvScanner` | CVE conhecida em dependência; o dependabot avisa de versão, não de vulnerabilidade |
| `zizmor` | segurança de workflows; o `actionlint` só valida sintaxe |
| `dotenvLint` | arquivos `.env`, que este repo usa via dotenvx |
| `prismaLint`, `actionlint`, `yamllint`, `markdownlint`, `shellcheck`, `checkov`, `hadolint`, `semgrep` | o resto do que o CI não roda |

### 2. `path_filters` exclui só o que afogaria a review

Fora: `src/generated/**` (o client do Prisma tem ~3 mil linhas por modelo), `pnpm-lock.yaml`,
`dist/`, `build/`, `coverage/` e minificados.

**Migrations não são filtradas.** Uma versão anterior desta configuração as excluía, o que era o
oposto do necessário: é o arquivo mais irreversível do repo. Elas têm bloco próprio de instruções e
o `squawk` rodando por cima.

### 3. `path_instructions` cobre o que é acionável por caminho

Oito blocos. Eles não repetem a política geral do repo, porque o CodeRabbit já lê os `CLAUDE.md`
via `knowledge_base.code_guidelines` — `**/CLAUDE.md` está no default de `filePatterns`. Duplicar
ali criaria duas fontes de verdade que divergem na primeira mudança.

O que sobra é o que depende do caminho: `domain/` sem framework nem ORM; `application/` sem import
de `infra/`; `infra/` traduzindo erro de infraestrutura em erro de domínio; a anotação de retorno
em função que devolve `Either`; a semântica dos sufixos de teste; migrations como irreversíveis;
`*.prisma` com um arquivo por módulo; workflows com actions fixadas e sem `pull_request_target`
sobre código não confiável.

A regra da anotação de retorno entrou porque `success(x)` sozinho infere `Either<unknown, X>` — um
erro que aparece longe da causa e que revisor humano também deixa passar.

### 4. Revisão opina, não bloqueia

`request_changes_workflow: false`. O gate de merge é o CI; o CodeRabbit informa. `profile:
assertive` porque o gate determinístico saiu e vale ver mais para calibrar depois com base no
ruído real.

`pre_merge_checks.title` e `.description` ficam em `warning`, não `error`: o título do PR vira a
mensagem de commit no squash merge, e o repo já exige Conventional Commits via commitlint — mas
avisar é coerente com a decisão de não bloquear.

`drafts: false` — PR em rascunho não é pedido de revisão. `abort_on_close: true` evita gastar
revisão em PR que já foi fechado, e `auto_incremental_review` revisa cada push em vez de só o
primeiro.

`base_branches: ['.*']` revisa PR para qualquer base. Sem isso, só o branch default (`master`)
seria revisado automaticamente — e com git flow o trabalho do dia a dia abre PR contra `develop`,
que ficaria sem revisão nenhuma. O curinga também cobre `release/*` e `support/*` sem precisar
manter uma lista à medida que os prefixos aparecem.

### 5. PRs do dependabot são revisados

Sem `ignore_usernames`. Um bump costuma render pouco comentário, mas o resumo de mudanças entre
versões tem valor num salto como o de TypeScript 6→7 que está aberto agora. Se o ruído incomodar, o
ajuste é uma linha.

### 6. `slop_detection` ligado

O repo é público. Marca PRs de baixa qualidade em vez de gastar uma revisão completa neles.

## Fora de escopo

- Instalação do app em `github.com/apps/coderabbitai`, que exige autorização OAuth do dono do repo.
- CLI local do CodeRabbit.
- Mudanças em CI, husky ou `package.json`.

## Riscos

- **Três PRs do dependabot abertos.** Com `assertive`, todos serão revisados assim que o app for
  instalado. Medir o ruído antes de calibrar.
- **`eslint` desligado** significa que achado de lint só aparece no log do CI, nunca inline no
  diff. Reversível trocando um booleano.
- **`knowledge_base` retém dados.** `learnings` e `pull_requests` ficam em `scope: local`, então o
  aprendizado não cruza para outros repositórios. Quem quiser desligar de vez usa
  `knowledge_base.opt_out`.
- **Treze ferramentas ligadas de uma vez.** Nenhuma foi observada em PR real ainda; a expectativa é
  que `squawk` e `osvScanner` paguem seu custo e que alguma das outras se revele barulhenta. É para
  calibrar depois dos primeiros PRs, não antes.
