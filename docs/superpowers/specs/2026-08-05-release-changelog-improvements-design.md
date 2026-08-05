# Changelog gerado no release — melhorias

## Contexto

`.releaserc.json` já roda `@semantic-release/changelog` (escreve `CHANGELOG.md` a cada release em
`master`) e `@semantic-release/commit-analyzer`/`@semantic-release/release-notes-generator` sem
nenhum `preset` explícito. Nenhum release aconteceu ainda neste projeto — `CHANGELOG.md` não
existe.

Sem `preset` configurado, `release-notes-generator@14.1.1` cai no default de
`@semantic-release/release-notes-generator`'s próprio loader (`conventional-changelog-angular`,
confirmado lendo `lib/load-changelog-config.js` do pacote instalado, não assumido) — e o preset
Angular marca `docs`, `style`, `chore`, `refactor`, `test`, `build` e `ci` como `hidden: true`
(confirmado lendo `conventional-changelog-angular/src/index.js` e o array de tipos default).
Só `feat`, `fix`, `perf` e `revert` aparecem no changelog final.

Isso diverge do que `dangerfile.ts`'s `featuresSection()` já mostra na descrição de cada PR — que
agrupa por `COMMIT_TYPE_LABELS` incluindo `docs`, `refactor`, `test`, `perf`, `build` e `ci`. O
changelog permanente (`CHANGELOG.md`, gerado só na release) fica menos informativo que o preview
temporário que já existe em toda PR.

_Achado à parte, fora do escopo desta spec: `apps/dispatch-worker` (adicionado numa wave anterior
desta mesma iniciativa) não tem nenhum pipeline de build/publish de imagem — só
`.github/workflows/release-image.yml` para `core-server` existe. Fica registrado aqui para não se
perder, mas é um projeto à parte (uma pipeline de release inteira nova), não uma "melhoria de
changelog"._

## Decisões

### 1. Trocar o preset implícito por `conventionalcommits`, com tipos customizados

`conventional-changelog-conventionalcommits` já está disponível no projeto como dependência
transitiva (confirmado em `node_modules/.pnpm`), mas não é uma dependência direta — vira uma agora,
declarada explicitamente, já que `.releaserc.json` passa a referenciá-la pelo nome
(`"preset": "conventionalcommits"` resolve para o pacote `conventional-changelog-<preset>`,
confirmado lendo o loader do `release-notes-generator`).

```json
"devDependencies": {
  "conventional-changelog-conventionalcommits": "10.2.1"
}
```

### 2. Lista de tipos customizada, espelhando `dangerfile.ts`'s `COMMIT_TYPE_LABELS`

Confirmado lendo o código-fonte real do preset (`src/writer.js`, `src/whatBump.js`,
`src/utils.js` de `conventional-changelog-conventionalcommits`): cada entrada de `types` tem um
`effect` que controla **duas coisas independentes**:

- `effect: 'bump'` — só usado por `whatBump.js` para decidir se aquele tipo de commit dispara uma
  release (patch no mínimo). Não afeta se o tipo aparece no changelog.
- `effect: 'hidden'` — só usado por `writer.js` para decidir se aquele tipo aparece no changelog.
  Não afeta se ele dispara release.
- Nenhum `effect` (omitido) — aparece no changelog, mas não dispara release por si só. É exatamente
  o comportamento que falta hoje para `docs`/`refactor`/`test`/`build`/`ci`: continuar sem forçar
  uma versão nova, mas deixar de ficar invisível no `CHANGELOG.md`.

```json
{
  "preset": "conventionalcommits",
  "presetConfig": {
    "types": [
      { "type": "feat", "section": "Features", "effect": "bump" },
      { "type": "fix", "section": "Fixes", "effect": "bump" },
      { "type": "perf", "section": "Performance", "effect": "bump" },
      { "type": "revert", "section": "Reverts", "effect": "bump" },
      { "type": "docs", "section": "Docs" },
      { "type": "refactor", "section": "Refactor" },
      { "type": "test", "section": "Tests" },
      { "type": "build", "section": "Build" },
      { "type": "ci", "section": "CI" },
      { "type": "style", "section": "Styles", "effect": "hidden" },
      { "type": "chore", "section": "Miscellaneous Chores", "effect": "hidden" }
    ]
  }
}
```

Os rótulos de seção (`Features`, `Fixes`, `Docs`, `Refactor`, `Tests`, `Performance`, `Build`,
`CI`) usam exatamente o texto de `COMMIT_TYPE_LABELS` em `dangerfile.ts` — quem já viu o resumo da
PR reconhece as mesmas categorias no `CHANGELOG.md` final. `style`/`chore` continuam ocultos (ruído
puro, sem valor para quem lê o changelog depois) — mesmo comportamento que o preset Angular já
tinha para esses dois, preservado deliberadamente.

### 3. A mesma config vale para os dois plugins que leem commits

`@semantic-release/commit-analyzer` (decide se uma release acontece e qual bump) e
`@semantic-release/release-notes-generator` (decide o que aparece no `CHANGELOG.md`) hoje não têm
nenhuma opção configurada — cada um resolve seu próprio default de preset de forma independente e
implícita. Os dois passam a declarar o mesmo `preset`/`presetConfig`, para que o tipo que dispara
release e o tipo que aparece no changelog fiquem garantidamente consistentes entre si, em vez de
depender de dois defaults concordarem por acidente.

```json
{
  "plugins": [
    ["@semantic-release/commit-analyzer", { "preset": "conventionalcommits", "presetConfig": { "types": [ ... mesma lista ... ] } }],
    ["@semantic-release/release-notes-generator", { "preset": "conventionalcommits", "presetConfig": { "types": [ ... mesma lista ... ] } }],
    ["@semantic-release/changelog", { "changelogFile": "CHANGELOG.md" }],
    "@semantic-release/github",
    ["@semantic-release/git", { "assets": ["CHANGELOG.md"], "message": "chore(release): ${nextRelease.version}" }]
  ]
}
```

(A lista de `types` se repete nos dois blocos — `.releaserc.json` é JSON puro, sem suporte a
variável/import para deduplicar. Aceitável para uma lista de 11 entradas que muda raramente.)

## Riscos

- **Nenhum release aconteceu ainda** — não há como validar o `CHANGELOG.md` resultante contra uma
  saída real do `semantic-release` neste ambiente (sem token de release, sem histórico de tags
  reais). A verificação fica limitada a rodar `semantic-release` em modo `--dry-run` localmente
  (sem `GITHUB_TOKEN` de escrita, só lendo o histórico de commits atual) para inspecionar as notas
  geradas, sem publicar nada de verdade.
- **Mudar de preset é uma mudança observável na primeira release real** — o formato exato de cada
  linha do changelog (ex: presença de link de commit, formatação de escopo) pode diferir
  sutilmente entre o preset Angular antigo (nunca usado de verdade, já que não houve release ainda)
  e o `conventionalcommits` novo. Como nenhum `CHANGELOG.md` existe ainda para comparar, não há
  regressão real de formato a perder — só uma primeira impressão a acertar.
- **`apps/dispatch-worker` sem pipeline de release** (achado do Contexto) — não é resolvido por
  esta spec, fica registrado como próximo passo em aberto, fora deste escopo.

## Resultado

_(preenchido depois da implementação)_
