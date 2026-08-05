# Changelog e versionamento independente por pacote, por app e do monorepo

## Contexto

A spec [2026-08-05-release-changelog-improvements-design.md](2026-08-05-release-changelog-improvements-design.md)
resolveu só metade do pedido original: melhorar o preset do `semantic-release` para que
`docs`/`refactor`/`test`/`build`/`ci` apareçam no `CHANGELOG.md` — mas continuava assumindo **uma
única versão para o monorepo inteiro** (a tag `v*` gerada na raiz, que hoje também dispara o build
da imagem Docker do `core-server` em `.github/workflows/release-image.yml`). O pedido revisado é
maior: changelog "de cada package e de cada app e do monorepo" — ou seja, cada um dos 12 workspaces
(`apps/core-server`, `apps/dispatch-worker`, as 7 pastas em `packages/*`, as 3 em `configs/*`) com
seu próprio changelog e sua própria versão, mais uma visão agregada do monorepo como um todo.

Confirmado lendo `pnpm-workspace.yaml`, os 12 `package.json` de workspace e o histórico de commits
(não presumido): hoje nada é publicado em registry nenhum — todo consumo interno é via
`workspace:*`, os 3 `configs/*` têm `publishConfig.access: "public"` declarado mas nunca usado (sem
passo de publish em nenhum workflow), e os demais ficam parados em `0.0.0`/`0.0.1`. O histórico de
commits já usa scope na maioria dos casos (`feat(cache)`, `fix(core-server)`, `fix(dispatch-worker)`
etc.), mas o commitlint (`commitlint.config.mjs`, que só estende
`@commitlint/config-conventional`) não obriga esse scope a bater com o nome de um pacote real —
por isso o mecanismo de atribuição de commit a pacote não pode depender do texto do scope, só do
que o commit efetivamente tocou (ver Decisão 1).

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
Decisão 7 (spike) existe para confirmar antes de qualquer coisa avançar.

### 2. Config compartilhada: um módulo JS na raiz, referenciado por cada `.releaserc` de pacote

Em vez de repetir a lista de `types` (a mesma decisão já aprovada em
[2026-08-05-release-changelog-improvements-design.md](2026-08-05-release-changelog-improvements-design.md)'s
Decisão 2, agora reaproveitada aqui) em 12 arquivos, um módulo `release.config.base.mjs` na raiz
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

### 4. Tag por pacote, formato a confirmar no spike

O padrão documentado da ferramenta é `${name}@${version}` (ex.: `my-pkg-1@1.0.1` conforme o próprio
README). Como nossos pacotes usam scope (`@ruguin/core-server`), o formato final da tag — com ou
sem o scope embutido — só é confirmado empiricamente no spike (Decisão 7), porque disso depende
diretamente o padrão exato usado na Decisão 6.

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

`.github/workflows/release-image.yml`'s `on.push.tags` muda de `['v*']` para o padrão de tag
exato que a Decisão 4 confirmar para `core-server` (ex.: `['core-server@*']`). O build da imagem
passa a disparar só quando `core-server` (ou algo de que ele dependa via `workspace:*`) realmente
muda — não mais a cada release de qualquer pacote do monorepo, incluindo pacotes sem nenhuma
relação com `core-server`.

### 7. Todos os 12 workspaces participam igualmente; `dispatch-worker` não ganha pipeline de imagem

Nenhuma lista de exclusão: `apps/*`, `packages/*` e `configs/*` recebem o mesmo tratamento — a
ferramenta já opera sobre o que `pnpm-workspace.yaml` declara, então recortar um subconjunto seria
uma exceção arbitrária sem benefício real. `apps/dispatch-worker` ganha versionamento e
`CHANGELOG.md` como qualquer outro workspace, mas continua **sem** nenhum workflow de build de
imagem — esse gap já está registrado como um achado separado, fora do escopo desta spec, na
spec de 2026-08-05 anterior.

### 8. Implementação: a primeira tarefa do plano é um spike em `--dry-run`, sem tocar CI ou configs reais

Decisão já confirmada com o usuário, dado o risco de imaturidade documentado na Decisão 1. A
primeira tarefa do plano de implementação roda `@anolilab/multi-semantic-release --dry-run` contra
o histórico real deste repositório (sem criar tags, sem escrever nenhum `CHANGELOG.md`, sem tocar
em nenhum `.releaserc` fora de uma configuração mínima de teste) e reporta, de forma concreta:

- se o parser da ferramenta lida com `workspace:*` sem quebrar;
- o formato exato de tag que ela produz para um pacote com scope (`@ruguin/core-server`);
- se os bumps calculados por pacote (incluindo propagação para dependentes internos) batem com o
  esperado, olhando o histórico de commits real.

Só depois desse resultado concreto as tarefas seguintes (12 `.releaserc` por pacote, o módulo
compartilhado, o script de agregação, a mudança em `release-image.yml`) são executadas. Se o spike
revelar que a ferramenta não se comporta como documentado, essa é a hora de reconsiderar — antes de
qualquer config real ou mudança de CI existir.

## Riscos

- **Este é o wave de maior risco de ferramenta desta sessão.** As três alternativas pesquisadas
  têm problemas reais e documentados (duas com sinais de abandono ou incompatibilidade de versão
  confirmados via GitHub/npm, a terceira pequena e nova). A Decisão 8 existe exatamente para não
  descobrir isso no meio de uma implementação já avançada.
- **`workspace:*` não é reescrito corretamente por nenhuma ferramenta desse nicho** — mitigado pela
  Decisão 3 (sem publish, então "reescrita errada" não é um problema real), mas o risco de o
  *parser* simplesmente falhar ao encontrar essa sintaxe só é eliminado pelo spike.
- **O formato exato da tag para pacotes com scope não está documentado** — só o padrão sem scope
  (`my-pkg-1@1.0.1`) aparece no README. A Decisão 6 (trigger do `release-image.yml`) depende
  diretamente desse formato, então fica bloqueada até o spike confirmar.
- **`@anolilab/multi-semantic-release` é pequena e nova** (54 stars, fork recente de um projeto
  maior) — mesmo sem bandeiras vermelhas hoje, é um risco de manutenção de longo prazo diferente
  de adotar uma ferramenta grande e estabelecida. Aceito conscientemente por ser, das três
  pesquisadas, a única sem um problema de compatibilidade ou abandono já confirmado.
- **Nenhuma validação real possível sem uma execução de CI de verdade** — mesmo limite já registrado
  nas specs de ESO e Valkey: o ambiente de implementação não publica de fato, então a confirmação
  final de que os 12 pacotes recebem tags e changelogs corretos só acontece no primeiro merge real
  para `develop`/`master` depois desta mudança.
- **Reduz, mas não elimina, a spec de 2026-08-05 anterior** — a ideia de "uma tag `v*`, um
  `CHANGELOG.md` na raiz com todo o histórico" deixa de existir como está descrita lá; a Decisão 2
  desta spec reaproveita a lista de `types` daquela spec, mas o mecanismo (`.releaserc.json` único
  na raiz) é substituído pelo módulo compartilhado + 12 configs por pacote. A spec anterior
  permanece como registro histórico da decisão original, não é apagada.

## Resultado

_(preenchido depois da implementação)_
