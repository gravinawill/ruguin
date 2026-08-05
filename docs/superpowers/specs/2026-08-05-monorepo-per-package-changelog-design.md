# Changelog e versionamento independente por pacote, por app e do monorepo

## Contexto

A spec [2026-08-05-release-changelog-improvements-design.md](2026-08-05-release-changelog-improvements-design.md)
resolveu só metade do pedido original: melhorar o preset do `semantic-release` para que
`docs`/`refactor`/`test`/`build`/`ci` apareçam no `CHANGELOG.md` — mas continuava assumindo **uma
única versão para o monorepo inteiro** (a tag `v*` gerada na raiz, que hoje também dispara o build
da imagem Docker do `core-server` em `.github/workflows/release-image.yml`). O pedido revisado é
maior: changelog "de cada package e de cada app e do monorepo" — ou seja, cada workspace com seu
próprio changelog e sua própria versão, mais uma visão agregada do monorepo como um todo.

Confirmado lendo `pnpm-workspace.yaml`, os `package.json` de workspace e o histórico de commits
(não presumido): hoje nada é publicado em registry nenhum — todo consumo interno é via
`workspace:*`, os 3 `configs/*` têm `publishConfig.access: "public"` declarado mas nunca usado (sem
passo de publish em nenhum workflow), e os demais ficam parados em `0.0.0`/`0.0.1`. O histórico de
commits já usa scope na maioria dos casos (`feat(cache)`, `fix(core-server)`, `fix(dispatch-worker)`
etc.), mas o commitlint (`commitlint.config.mjs`, que só estende
`@commitlint/config-conventional`) não obriga esse scope a bater com o nome de um pacote real —
por isso o mecanismo de atribuição de commit a pacote não pode depender do texto do scope, só do
que o commit efetivamente tocou (ver Decisão 1).

**Correção pós-spike:** o número original de "12 workspaces" estava errado — `packages/ddd-kernel`
foi renomeado pra `packages/shared-domain` num commit anterior (`98a7d0e`) e não existe mais como
pacote real (só resto de build no disco, sem `package.json`). São **11 workspaces reais**:
`apps/core-server`, `apps/dispatch-worker`, `packages/cache`, `packages/env`,
`packages/event-schemas`, `packages/message-broker`, `packages/shared-domain`, `packages/utils`,
`configs/eslint-config`, `configs/prettier-config`, `configs/typescript-config`. Achado durante o
spike (Decisão 8), não durante a escrita original desta spec.

## Decisões

### 1. Ferramenta: `@anolilab/multi-semantic-release`, mantendo o fluxo 100% automático já existente

Decisão já confirmada com o usuário: manter tudo dirigido só pela mensagem de commit (sem arquivo
manual por PR, ao contrário de Changesets). Entre as três alternativas pesquisadas nesta categoria
(consultando os repositórios reais no GitHub e os registros de npm, não por suposição):

- `@qiwi/multi-semantic-release`: o próprio mantenedor declara que está migrando para outra
  ferramenta (`bulk-release`) e que este pacote passa a receber manutenção "residual"; a última
  versão publicada (`7.1.2`) ainda fixa `semantic-release: ^21.0.5` como dependência direta
  (não peer) — incompatível com o `semantic-release@25.0.8` já usado aqui.
- `multi-semantic-release` (dhoulb, o pacote original): o repositório no GitHub está ativo de
  verdade (commit de suporte ao semantic-release v25 mesclado), mas **isso nunca foi publicado no
  npm** — a versão publicada mais recente (`3.1.0`) ainda declara `semantic-release: ^17.3.0`.
  Instalar via npm hoje traria código defasado, incompatível com nossa versão.
- `@anolilab/multi-semantic-release` (`^4.4.6`): `peerDependencies` declara
  `semantic-release: ">=24.2.9"` — compatível com nossa `25.0.8` — e tem atividade de commit
  recente de verdade (não apenas tags antigas). Exige Node `^22.14.0 || >=24.10.0`; o projeto já
  roda em Node `26.5.0` (`package.json`'s `engines`, `.nvmrc`), então não é um bloqueio.

Nenhuma das três é uma ferramenta grande/estabelecida — `@anolilab/multi-semantic-release` é a
única sem uma bandeira vermelha clara (abandono declarado ou incompatibilidade de versão), mas
ainda é pequena (54 stars no momento da pesquisa). Por isso a Decisão 7 (spike primeiro) existe.

**Risco aceito e documentado, não resolvido por nenhuma das três:** o protocolo `workspace:*` do
pnpm nas dependências internas não é reescrito corretamente por nenhuma dessas ferramentas
(lacuna documentada tanto no README do `dhoulb/multi-semantic-release` quanto numa issue aberta do
`qiwi/multi-semantic-release`). Como a Decisão 3 já elimina qualquer publish real, isso não chega a
importar como "versão errada publicada" — mas fica em aberto se o parser da ferramenta escolhida
sequer consegue ler um `package.json` com `workspace:*` sem quebrar. Isso é exatamente o que a
Decisão 8 (spike) existiu para confirmar antes de qualquer coisa avançar — e confirmou que não
quebra (ver Decisão 8).

### 2. Config compartilhada: um módulo JS na raiz, referenciado por cada `.releaserc` de pacote

Em vez de repetir a lista de `types` (a mesma decisão já aprovada em
[2026-08-05-release-changelog-improvements-design.md](2026-08-05-release-changelog-improvements-design.md)'s
Decisão 2, agora reaproveitada aqui) em 11 arquivos, um módulo `release.config.base.mjs` na raiz
exporta o preset e a lista de `types` como um objeto:

```js
// release.config.base.mjs
export const releasePreset = {
  preset: 'conventionalcommits',
  presetConfig: {
    types: [
      { type: 'feat', section: 'Features', effect: 'bump' },
      { type: 'fix', section: 'Fixes', effect: 'bump' },
      { type: 'perf', section: 'Performance', effect: 'bump' },
      { type: 'revert', section: 'Reverts', effect: 'bump' },
      { type: 'docs', section: 'Docs' },
      { type: 'refactor', section: 'Refactor' },
      { type: 'test', section: 'Tests' },
      { type: 'build', section: 'Build' },
      { type: 'ci', section: 'CI' },
      { type: 'style', section: 'Styles', effect: 'hidden' },
      { type: 'chore', section: 'Miscellaneous Chores', effect: 'hidden' }
    ]
  }
}
```

Cada pacote (ex: `packages/cache/.releaserc.json` ou, se o `.json` não conseguir importar o módulo
JS — a confirmar no spike — `packages/cache/release.config.mjs`) importa esse módulo e monta seus
próprios `commit-analyzer`/`release-notes-generator` a partir dele, adicionando só o que for
específico daquele pacote. Nenhum pacote redeclara a lista de `types`.

### 3. Sem publish real em nenhum pacote

Decisão já confirmada com o usuário. Nenhum `.releaserc` de pacote inclui `@semantic-release/npm`
com publish habilitado — a própria `@anolilab/multi-semantic-release` escreve o número de versão
correto em cada `package.json` no seu passo de "prepare", independente de publish (confirmado no
README do fork: "the correct current/next version number of all local dependencies is written into
the package.json file" antes do passo de release). Isso vale igualmente para os 3 `configs/*` que
já têm `publishConfig.access: "public"` — esse campo continua ali, sem uso, como já está hoje.

### 4. Tag por pacote: `${name}@${version}`, com o scope incluído — confirmado empiricamente

O padrão documentado da ferramenta é `${name}@${version}` (ex.: `my-pkg-1@1.0.1` conforme o próprio
README). O spike (Decisão 8) confirmou que isso vale com o scope incluído: a saída real do
dry-run mostrou `Skip @ruguin/core-server@1.0.0 tag creation in dry-run mode` — a tag pra
`core-server` é `@ruguin/core-server@1.0.0`, não uma versão sem scope. Esse é o padrão exato usado
na Decisão 6.

### 5. Changelog do monorepo: índice agregado gerado, sem versão própria

Decisão já confirmada com o usuário. Não existe mais uma "versão do monorepo inteiro" — só as 12
versões por workspace. Um script Node pequeno (`scripts/aggregate-changelog.mjs` ou path
equivalente dentro de `scripts/`, a decidir na fase de plano) roda depois que a
`@anolilab/multi-semantic-release` termina numa mesma execução de CI, lê quais tags novas foram
criadas nessa rodada, e acrescenta uma entrada datada ao `CHANGELOG.md` da raiz, listando os
pacotes que mudaram nessa rodada com link para a seção correspondente do `CHANGELOG.md` de cada um.
Esse script é o único componente totalmente sob nosso controle nesta spec — por isso é
deliberadamente pequeno e testável, em vez de depender de mais uma ferramenta de terceiros para
essa parte.

### 6. `release-image.yml`: trigger muda de `v*` para o padrão de tag do `core-server`

`.github/workflows/release-image.yml`'s `on.push.tags` muda de `['v*']` para
`['@ruguin/core-server@*']` (o padrão exato confirmado na Decisão 4). O build da imagem passa a
disparar só quando `core-server` (ou algo de que ele dependa via `workspace:*`, confirmado que
propaga bump — ver Decisão 8) realmente muda — não mais a cada release de qualquer pacote do
monorepo, incluindo pacotes sem nenhuma relação com `core-server`. O `promote` job da spec de
[2026-08-05-immutable-release-tags-design.md](2026-08-05-immutable-release-tags-design.md) (que já
lê `steps.build.outputs.digest` e escreve no overlay de `core-server`) não muda de mecanismo —
só passa a disparar por esse novo padrão de tag em vez do antigo `v*`.

### 7. Todos os 11 workspaces participam igualmente; `dispatch-worker` não ganha pipeline de imagem

Nenhuma lista de exclusão: `apps/*`, `packages/*` e `configs/*` recebem o mesmo tratamento — a
ferramenta já opera sobre o que `pnpm-workspace.yaml` declara, então recortar um subconjunto seria
uma exceção arbitrária sem benefício real. `apps/dispatch-worker` ganha versionamento e
`CHANGELOG.md` como qualquer outro workspace, mas continua **sem** nenhum workflow de build de
imagem — esse gap já está registrado como um achado separado, fora do escopo desta spec, na
spec de 2026-08-05 anterior.

**Correção pós-spike:** `@anolilab/multi-semantic-release` tem `ignorePrivate: true` como default
(confirmado lendo o código-fonte real, `src/multi-semantic-release.ts`'s filtro de descoberta de
pacotes, e o CLI flag `--ignore-private`/`--no-ignore-private` em `src/bin/cli.ts`) — sem
configuração explícita, os 5 pacotes com `"private": true` (`cache`, `event-schemas`,
`message-broker`, `shared-domain`, `utils`) seriam silenciosamente excluídos de toda a análise,
contradizendo esta mesma Decisão 7. A config raiz da ferramenta (`.multi-releaserc.json` ou
equivalente, a decidir na fase de plano) precisa declarar `"ignorePrivate": false` explicitamente
para que os 11 workspaces participem de verdade, como já pretendido.

### 8. Spike em duas rodadas — concluído, tag format e propagação de dependência confirmados

Decisão já confirmada com o usuário, dado o risco de imaturidade documentado na Decisão 1. Rodou
em duas rodadas (a segunda necessária porque a primeira esbarrou em bloqueios do próprio pipeline
do `semantic-release`, não da ferramenta em si):

- **Rodada 1**: `.releaserc.json`'s `branches: ["master"]` bloqueou a análise antes de qualquer
  lógica de versionamento rodar (o worktree de implementação não está em `master`). Confirmou,
  ainda assim: nenhum erro de parsing de `workspace:*`; 5 dos 11 pacotes reais silenciosamente
  ausentes da análise (os mesmos 5 com `"private": true` — correlação 100%, então inferida, não
  confirmada na hora); formato de tag e propagação de dependência ficaram em aberto.
- **Rodada 2**: config de release descartável (branches wildcard, sem `@semantic-release/github`/
  `git`/`changelog`) pra contornar os dois bloqueios da rodada 1. Bateu num bloqueio novo,
  inesperado: `branches: ["*"]` casou 5 branches locais (este repositório usa `git worktree`
  pesadamente, cada worktree ativo soma uma branch local) — acima do limite de 3 branches do
  `semantic-release` (`ERELEASEBRANCHES`). Contornado com um override pontual via CLI
  (`--branches <nome-da-branch-atual>`, sem mudar nenhum arquivo), que completou de verdade
  ("Released 6 of 6 packages, semantically!") e confirmou as duas perguntas em aberto: tag format
  (Decisão 4) e propagação de bump entre workspace dependentes (`packages/env` mudando gerou uma
  seção "### Dependencies" com "`@ruguin/env: upgraded to 1.0.0`" nas release notes computadas de
  `apps/core-server`, que depende dele via `workspace:*`).

Achado adicional, confirmado depois via leitura do código-fonte da ferramenta (não apenas
correlação): os 5 pacotes ausentes eram por causa do default `ignorePrivate: true` — ver Decisão 7.

Nenhuma das duas rodadas tocou config real nem CI — cada uma instalou a ferramenta como
devDependency temporária, rodou, e reverteu tudo antes de commitar só o relatório de achados
(`docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md` e
`docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-round2-findings.md`).

### 9. `branches` na config real: lista explícita, nunca wildcard

Achado da rodada 2 do spike, novo em relação ao design original: `branches: ["*"]` não é seguro
neste repositório especificamente, porque cada worktree ativo (o mecanismo que as sessões deste
projeto usam pra isolar trabalho) soma uma branch local, e o `semantic-release` tem um limite
rígido de 3 branches (`ERELEASEBRANCHES` acima disso). A config raiz da ferramenta declara
`"branches": ["master"]` explicitamente — mesmo valor que `.releaserc.json` já usa hoje para o
mecanismo antigo, preservando o mesmo comportamento (só libera versão a partir de `master`), sem
introduzir rastreamento de `develop` como parte desta spec — isso ficaria pra uma decisão
separada, não implícita nesta mudança.

## Riscos

- **Este foi o wave de maior risco de ferramenta desta sessão — resolvido pelo spike em duas
  rodadas.** As três alternativas pesquisadas tinham problemas reais e documentados; o spike
  confirmou que a escolhida (`@anolilab/multi-semantic-release`) funciona de verdade contra este
  repositório, incluindo o formato de tag e a propagação de dependência (Decisão 8).
- **`workspace:*` não é reescrito corretamente por nenhuma ferramenta desse nicho** — mitigado pela
  Decisão 3 (sem publish, então "reescrita errada" não é um problema real). O spike confirmou que o
  *parser* não quebra ao encontrar essa sintaxe (nenhum erro relacionado a `workspace:*` em nenhuma
  das duas rodadas) — risco fechado.
- **Limite de 3 branches do `semantic-release` colide com o uso pesado de `git worktree` deste
  projeto.** Achado real da rodada 2 (Decisão 9), não hipotético — `branches: ["*"]` bateu no
  limite com 5 worktrees ativos no momento do spike. Mitigado com uma lista explícita
  (`["master"]`) na config real, não um wildcard.
- **`@anolilab/multi-semantic-release` é pequena e nova** (54 stars, fork recente de um projeto
  maior) — mesmo sem bandeiras vermelhas hoje, é um risco de manutenção de longo prazo diferente
  de adotar uma ferramenta grande e estabelecida. Aceito conscientemente por ser, das três
  pesquisadas, a única sem um problema de compatibilidade ou abandono já confirmado.
- **Nenhuma validação real possível sem uma execução de CI de verdade** — mesmo limite já registrado
  nas specs de ESO e Valkey: o ambiente de implementação não publica de fato, então a confirmação
  final de que os 11 pacotes recebem tags e changelogs corretos só acontece no primeiro merge real
  para `develop`/`master` depois desta mudança.
- **Reduz, mas não elimina, a spec de 2026-08-05 anterior** — a ideia de "uma tag `v*`, um
  `CHANGELOG.md` na raiz com todo o histórico" deixa de existir como está descrita lá; a Decisão 2
  desta spec reaproveita a lista de `types` daquela spec, mas o mecanismo (`.releaserc.json` único
  na raiz) é substituído pelo módulo compartilhado + 11 configs por pacote. A spec anterior
  permanece como registro histórico da decisão original, não é apagada.

## Resultado

**Fase 1 (spike, Decisão 8) concluída em duas rodadas** — commits `bd5f110`..`e75ce10` (rodada 1)
e `d73f4b2`..`99cf878` (rodada 2), cada uma revisada limpa. A ferramenta é viável, com ressalvas
já incorporadas às Decisões 7 e 9 acima: `ignorePrivate: false` precisa ser configurado
explicitamente (o default da ferramenta exclui os pacotes `private: true` silenciosamente), e
`branches` precisa ser uma lista explícita (`["master"]`), nunca `["*"]`, por causa do limite de
3 branches do `semantic-release` colidindo com o uso pesado de `git worktree` deste projeto.

Achados confirmados com evidência real (não suposição): tag format `${name}@${version}` com scope
incluído (`@ruguin/core-server@1.0.0`); propagação de bump entre workspaces dependentes via
`workspace:*` funciona; `workspace:*` nunca causou erro de parsing em nenhuma das duas rodadas;
contagem real de workspaces corrigida de 12 pra 11 (`packages/ddd-kernel` não existe mais).

**Fase 2 (implementação real — configs por pacote, módulo compartilhado, script de agregação,
mudança em `release-image.yml`) ainda não iniciada** — o plano de implementação é escrito
separadamente, agora que a Fase 1 removeu toda a incerteza que a bloqueava.
