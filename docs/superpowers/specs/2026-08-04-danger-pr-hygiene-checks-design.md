# Danger — checagens extras de higiene de PR

## Contexto

`dangerfile.ts` hoje cobre coverage, commits, endpoints, gif na descrição, `.only`/`.skip`
esquecido, TODOs novos e anotação inline de lint (wave anterior, `docs/superpowers/specs/
2026-08-04-danger-coderabbit-improvements-design.md`). Esta wave adiciona quatro checagens
pedidas explicitamente: source sem teste correspondente, tamanho de PR, donos sugeridos via
CODEOWNERS, e labels automáticas por área tocada.

## Decisões

### 1. Aviso de source sem teste correspondente

Para todo arquivo em `danger.git.modified_files` ou `danger.git.created_files` que:
- esteja sob um segmento de path `application/` ou `domain/`, e
- não esteja sob um segmento `__tests__/` (não é ele próprio um teste),

verifica se existe algum arquivo no MESMO diff cujo path seja
`<diretório-do-source>/__tests__/<nome-base-do-source>.*.ts` (qualquer sufixo — `.unit.ts`,
`.int.ts`, `.e2e.ts` — já que um source pode ter mais de um tipo de teste, ou só um). Se nenhum
casar, `warn()` listando os arquivos sem teste tocado.

`warn()`, não `fail()`: há casos legítimos de mudança sem teste novo (comentário, refactor já
coberto, mudança só de tipo) — travar a PR nesses casos geraria falso positivo constante.

```ts
function sourceWithoutTestWarning(): void {
  const changedFiles = [...danger.git.modified_files, ...danger.git.created_files]
  const sourceFiles = changedFiles.filter(
    (file) => /\/(application|domain)\//.test(file) && !file.includes('/__tests__/')
  )

  const withoutTest = sourceFiles.filter((sourceFile) => {
    const lastSlash = sourceFile.lastIndexOf('/')
    const directory = sourceFile.slice(0, lastSlash)
    const fileName = sourceFile.slice(lastSlash + 1)
    const baseName = fileName.replace(/\.ts$/, '')
    const testPrefix = `${directory}/__tests__/${baseName}.`
    return !changedFiles.some((file) => file.startsWith(testPrefix) && file.endsWith('.ts'))
  })

  if (withoutTest.length === 0) return
  warn(
    `Os arquivos abaixo mudaram em \`application/\`/\`domain/\` sem um teste correspondente no mesmo diff:\n${withoutTest.map((file) => `- \`${file}\``).join('\n')}`
  )
}
```

### 2. Aviso de PR grande

`danger.github.pr.additions + danger.github.pr.deletions > 500` → `warn()` sugerindo quebrar em
PRs menores. 500 é um limite comum em outros dangerfiles públicos e razoável para este projeto —
ajustável depois se gerar ruído.

```ts
const LARGE_PR_LINE_THRESHOLD = 500

function largePrWarning(): void {
  const totalLines = danger.github.pr.additions + danger.github.pr.deletions
  if (totalLines <= LARGE_PR_LINE_THRESHOLD) return
  warn(
    `Esta PR tem ${totalLines} linhas alteradas (limite sugerido: ${LARGE_PR_LINE_THRESHOLD}). Considere quebrar em PRs menores para facilitar a review.`
  )
}
```

### 3. `.github/CODEOWNERS` + seção informativa de donos

Arquivo novo, mínimo:

```
* @gravinawill
```

Único colaborador no momento (confirmado com o usuário) — regra `*` cobre tudo. Quando houver
mais colaboradores, o arquivo ganha regras por pasta (`infrastructure/ @alguem`, etc.) sem
precisar mudar o `dangerfile.ts`.

No `dangerfile.ts`, uma seção informativa parseia o CODEOWNERS e lista os donos dos arquivos
tocados — só texto na PR, **não chama a API para pedir review de verdade** (`request review`
notifica e adiciona a pessoa à PR; "sugerir" pedido pelo usuário é mais bem servido por uma lista
informativa que ninguém precisa aceitar/rejeitar).

```ts
function parseCodeowners(text: string): ReadonlyArray<{ pattern: string; owners: string[] }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/)
      return { pattern: pattern ?? '', owners }
    })
}

function matchesCodeownersPattern(filePath: string, pattern: string): boolean {
  if (pattern === '*') return true
  const normalized = pattern.replace(/^\//, '').replace(/\/$/, '')
  return filePath === normalized || filePath.startsWith(`${normalized}/`)
}

function suggestedReviewersSection(): string {
  if (!existsSync('.github/CODEOWNERS')) return ''
  const rules = parseCodeowners(readFileSync('.github/CODEOWNERS', 'utf8'))
  const changedFiles = [...danger.git.modified_files, ...danger.git.created_files]

  const owners = new Set<string>()
  for (const file of changedFiles) {
    for (const rule of rules) {
      if (matchesCodeownersPattern(file, rule.pattern)) {
        for (const owner of rule.owners) owners.add(owner)
      }
    }
  }

  if (owners.size === 0) return ''
  return `## 👀 Donos sugeridos (CODEOWNERS)\n\n${[...owners].join(', ')}`
}
```

### 4. Labels automáticas por área tocada

Mapa de prefixo de path → label, aplicado via `danger.github.api.issues.addLabels(...)` (Octokit
real, exposto pelo próprio Danger — confirmado lendo `GitHubDSL.d.ts`, sem plugin externo
necessário). As 4 labels que não existiam (`terraform`, `kubernetes`, `core-server`,
`dispatch-worker`) já foram criadas no repositório real via `gh label create` durante o
brainstorming — a API do GitHub exige que a label já exista antes de aplicá-la a uma PR (404
senão), então o `dangerfile.ts` só aplica, nunca cria. `github_actions` e `documentation` já
existiam, reaproveitadas em vez de duplicadas.

```ts
const AREA_LABELS: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: 'infrastructure/terraform/', label: 'terraform' },
  { prefix: 'infrastructure/k8s/', label: 'kubernetes' },
  { prefix: 'apps/core-server/', label: 'core-server' },
  { prefix: 'apps/dispatch-worker/', label: 'dispatch-worker' },
  { prefix: '.github/workflows/', label: 'github_actions' },
  { prefix: 'docs/', label: 'documentation' }
]

async function applyAreaLabels(): Promise<void> {
  const changedFiles = [...danger.git.modified_files, ...danger.git.created_files, ...danger.git.deleted_files]
  const labels = new Set<string>()
  for (const file of changedFiles) {
    for (const area of AREA_LABELS) {
      if (file.startsWith(area.prefix)) labels.add(area.label)
    }
  }
  if (labels.size === 0) return

  try {
    await danger.github.api.issues.addLabels({
      owner: danger.github.thisPR.owner,
      repo: danger.github.thisPR.repo,
      // `number` on GitHubAPIPR is deprecated in favor of `pull_number`, confirmed reading
      // danger's own GitHubDSL.d.ts — the Octokit `addLabels` param is `issue_number`, but a
      // PR's number and its underlying issue number are the same value on GitHub.
      issue_number: danger.github.thisPR.pull_number,
      labels: [...labels]
    })
  } catch (error: unknown) {
    warn(`Não consegui aplicar labels automáticas: ${String(error)}`)
  }
}
```

Assíncrono → `schedule(applyAreaLabels())`, com `.catch()` já dentro da própria função (não deixa
uma falha de API derrubar o resto do dangerfile, mesmo padrão da wave anterior).

### 5. Posicionamento no `dangerfile.ts`

Seguindo a lição da wave anterior (revisão final encontrou: qualquer exceção síncrona antes do
`markdown(...)` final descarta o relatório inteiro): `sourceWithoutTestWarning()` e
`largePrWarning()` são síncronas e chamadas junto de `noTestShortcuts(...)`, logo acima do bloco
final. `suggestedReviewersSection()` entra no array `sections` (mesmo padrão de
`coverageSection()`/`gifSection()`). `schedule(applyAreaLabels())` entra junto dos outros
`schedule(...)` já existentes.

## Riscos

- **`danger.github.api.issues.addLabels` precisa que o token do CI tenha permissão de escrita em
  issues/PRs.** O job `ci` em `ci.yml` já tem `pull-requests: write` (usado hoje pelo próprio
  passo do Danger) — a API de labels de um PR usa o endpoint de Issues por baixo
  (`issues.addLabels`), que também é coberto por essa mesma permissão. Não deveria precisar de
  escopo extra, mas só confirma de verdade num run real do CI.
- **CODEOWNERS com um único dono não testa o caso de múltiplos donos por arquivo.** O parser
  suporta isso (`rule.owners` é uma lista), mas a verificação real desta wave só vai poder
  exercitar o caso de um dono só. Ficará coberto de verdade quando houver mais colaboradores.
- **O parser de CODEOWNERS implementado aqui é simplificado** (não suporta a sintaxe completa de
  `.gitignore`-like glob que o GitHub aceita em CODEOWNERS reais — só prefixo de path e `*`
  global). Suficiente para o arquivo mínimo desta wave; se o CODEOWNERS real crescer com padrões
  mais complexos no futuro, o parser precisa crescer junto.

## Resultado

_(preenchido depois da implementação)_
