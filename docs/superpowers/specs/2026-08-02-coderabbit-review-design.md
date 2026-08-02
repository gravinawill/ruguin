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

`eslint` e `biome` ficam desabilitados. O CI reprova o PR quando falham, e um segundo relatório do
mesmo achado é ruído. Ficam ligadas as ferramentas que o CI não cobre: `actionlint`, `yamllint`,
`markdownlint`, `semgrep`, `prismaLint`, `shellcheck`, `checkov`.

`gitleaks` é a única duplicação aceita: secret vazado é irreversível, e o comentário inline no diff
é mais acionável do que uma linha no log do CI.

`languagetool` fica desligado porque a CLAUDE.md raiz está em português e ele produziria correções
gramaticais sobre prosa que não é inglês.

### 2. `path_filters` exclui o que afogaria a review

Fora: `src/generated/**` (o client do Prisma tem ~3 mil linhas por modelo), `pnpm-lock.yaml`,
`dist/`, `build/`, `coverage/`, `prisma/migrations/**` e minificados.

### 3. `path_instructions` carrega as regras que são deste repo

Sete blocos, por camada: `domain/` sem framework nem ORM; `application/` sem import de `infra/`,
com service que só encaminha e use case que não chama use case; `infra/` traduzindo erro de
infraestrutura em erro de domínio; `**/*.ts` com `Either` para falha esperada, anotação de retorno
obrigatória em função que devolve `Either`, limite de 500 linhas e a política de comentários;
`__tests__/` com nome em inglês e semântica por sufixo; `*.prisma` com um arquivo por módulo;
workflows com actions fixadas e permissões mínimas.

A regra da anotação de retorno entrou porque `success(x)` sozinho infere `Either<unknown, X>` — um
erro que aparece longe da causa e que revisor humano também deixa passar.

### 4. Revisão opina, não bloqueia

`request_changes_workflow: false`. O gate de merge é o CI; o CodeRabbit informa. `profile:
assertive` porque o gate determinístico saiu e vale ver mais para calibrar depois com base no
ruído real.

`drafts: false` — PR em rascunho não é pedido de revisão.

## Fora de escopo

- Instalação do app em `github.com/apps/coderabbitai`, que exige autorização OAuth do dono do repo.
- CLI local do CodeRabbit.
- Mudanças em CI, husky ou `package.json`.

## Riscos

- **Três PRs do dependabot abertos.** Com `assertive`, todos serão revisados assim que o app for
  instalado. Bump de dependência rende pouco comentário útil; medir o ruído antes de calibrar.
- **`eslint` desligado** significa que achado de lint só aparece no log do CI, nunca inline no
  diff. Reversível trocando um booleano.
- **`path_instructions` envelhece.** São as regras da CLAUDE.md duplicadas em outro arquivo; quando
  uma mudar, os dois lugares precisam mudar juntos.
