import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { danger, markdown, schedule, warn } from 'danger'
import lintReport from 'danger-plugin-lint-report'
import noTestShortcutsPkg from 'danger-plugin-no-test-shortcuts'
import todosPkg from 'danger-plugin-todos'

type CoverageMetric = 'statements' | 'branches' | 'functions' | 'lines'
type CoverageSummary = { total: Record<CoverageMetric, { pct: number }> }
type Thresholds = Record<CoverageMetric, number>

/*
 * Both plugins are CJS-only (exports.default = fn, no ESM build). Danger evaluates dangerfile.ts
 * through its own transpiler (ts.transpileModule against the nearest tsconfig.json), not Node's
 * native ESM loader — and this repo's root tsconfig.json has no compilerOptions block, so
 * TypeScript's esModuleInterop defaults to false. That's why a bare default import binds to the
 * raw CJS exports object here instead of being auto-unwrapped, and why .default must be
 * dereferenced explicitly below. This would silently break if the root tsconfig.json ever gains
 * an explicit compilerOptions block that sets esModuleInterop: true.
 */
const noTestShortcuts = (noTestShortcutsPkg as unknown as { default: typeof noTestShortcutsPkg }).default
const todos = (todosPkg as unknown as { default: typeof todosPkg }).default

const PACKAGES: ReadonlyArray<{ name: string; dir: string }> = [
  { name: '@ruguin/cache', dir: 'packages/cache' },
  { name: '@ruguin/core-server', dir: 'apps/core-server' },
  { name: '@ruguin/env', dir: 'packages/env' },
  { name: '@ruguin/shared-domain', dir: 'packages/shared-domain' },
  { name: '@ruguin/utils', dir: 'packages/utils' }
]

function readThresholds(configPath: string): Thresholds | undefined {
  if (!existsSync(configPath)) return undefined
  const text = readFileSync(configPath, 'utf8')
  const block = /thresholds:\s*\{([^}]+)\}/.exec(text)
  if (block === null) return undefined
  const body = block[1] ?? ''
  const patterns: Record<CoverageMetric, RegExp> = {
    statements: /statements:\s*(\d+)/,
    branches: /branches:\s*(\d+)/,
    functions: /functions:\s*(\d+)/,
    lines: /lines:\s*(\d+)/
  }
  const pick = (key: CoverageMetric): number => {
    const found = patterns[key].exec(body)
    return found === null ? 0 : Number(found[1])
  }
  return {
    statements: pick('statements'),
    branches: pick('branches'),
    functions: pick('functions'),
    lines: pick('lines')
  }
}

function readCoverage(summaryPath: string): CoverageSummary | undefined {
  if (!existsSync(summaryPath)) return undefined
  return JSON.parse(readFileSync(summaryPath, 'utf8')) as CoverageSummary
}

function coverageSection(): string {
  const rows = PACKAGES.map(({ name, dir }) => {
    const summary = readCoverage(`${dir}/coverage/coverage-summary.json`)
    const thresholds = readThresholds(`${dir}/vitest.config.ts`)
    if (summary === undefined || thresholds === undefined) return
    const cell = (key: CoverageMetric): string => {
      const pct = summary.total[key].pct
      const min = thresholds[key]
      return `${pct.toFixed(2)}% ${pct >= min ? '✅' : '❌'} (min ${min})`
    }
    return `| ${name} | ${cell('statements')} | ${cell('branches')} | ${cell('functions')} | ${cell('lines')} |`
  }).filter((row): row is string => row !== undefined)

  if (rows.length === 0) return ''
  return [
    '## 📊 Coverage Report',
    '',
    '| Package | Statements | Branches | Functions | Lines |',
    '|---|---|---|---|---|',
    ...rows
  ].join('\n')
}

const COMMIT_TYPE_LABELS: Record<string, string> = {
  feat: 'Features',
  fix: 'Fixes',
  docs: 'Docs',
  refactor: 'Refactor',
  test: 'Tests',
  perf: 'Performance',
  build: 'Build',
  ci: 'CI'
}

function featuresSection(): string {
  const grouped = new Map<string, string[]>()
  for (const commit of danger.git.commits) {
    const firstLine = commit.message.split('\n', 1)[0] ?? ''
    const match = /^(\w+)(?:\([^)]+\))?:\s*(.+)/.exec(firstLine)
    if (match === null) continue
    const type = match[1]
    const description = match[2]
    if (type === undefined || description === undefined) continue
    const label = COMMIT_TYPE_LABELS[type]
    if (label === undefined) continue
    const list = grouped.get(label) ?? []
    list.push(description)
    grouped.set(label, list)
  }

  if (grouped.size === 0) return ''
  const sections: string[] = []
  for (const [label, items] of grouped) {
    const list = items.map((item) => `- ${item}`).join('\n')
    sections.push(`**${label}**\n${list}`)
  }
  return ['## 📋 Changes in this PR', '', ...sections].join('\n\n')
}

/*
 * Mirrors apps/core-server/src/shared/infrastructure/bootstrap/configure-app.ts's
 * app.enableVersioning({ defaultVersion: '1' }) — this is a static scan, it can't read the
 * running app's config, so it hardcodes the same default. Keep in sync if that call changes.
 */
const DEFAULT_API_VERSION = '1'
const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'] as const

function findControllerFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = `${directory}/${entry.name}`
    if (entry.isDirectory()) return findControllerFiles(fullPath)
    return entry.isFile() && entry.name.endsWith('.controller.ts') ? [fullPath] : []
  })
}

function resolveVersion(versionMatch: RegExpExecArray | null): string {
  if (versionMatch === null) return DEFAULT_API_VERSION
  if (versionMatch[1] === 'VERSION_NEUTRAL') return ''
  return versionMatch[2] ?? DEFAULT_API_VERSION
}

function extractControllerMeta(text: string): { path: string; version: string } {
  const objectForm = /@Controller\(\s*\{([^}]*)\}\s*\)/.exec(text)
  if (objectForm !== null) {
    const body = objectForm[1] ?? ''
    const pathMatch = /\bpath:\s*['"`]([^'"`]*)['"`]/.exec(body)
    const versionMatch = /\bversion:\s*(VERSION_NEUTRAL|['"`]([^'"`]*)['"`])/.exec(body)
    return { path: pathMatch?.[1] ?? '', version: resolveVersion(versionMatch) }
  }
  const stringForm = /@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/.exec(text)
  return { path: stringForm?.[1] ?? '', version: DEFAULT_API_VERSION }
}

function endpointsSection(): string {
  const controllerFiles = existsSync('apps')
    ? readdirSync('apps').flatMap((app) => findControllerFiles(`apps/${app}/src`))
    : []

  const rows: string[] = []
  for (const file of controllerFiles) {
    const text = readFileSync(file, 'utf8')
    const { path: prefix, version } = extractControllerMeta(text)
    const versionSegment = version === '' ? '' : `v${version}`
    for (const method of HTTP_METHODS) {
      const regex = new RegExp(`@${method}\\(\\s*['"\`]?([^'"\`)]*)['"\`]?\\s*\\)`, 'g')
      let match: RegExpExecArray | null
      while ((match = regex.exec(text)) !== null) {
        const endpointPath = match[1] ?? ''
        const fullPath = [versionSegment, prefix, endpointPath].filter((part) => part !== '').join('/')
        rows.push(`| ${method.toUpperCase()} | /${fullPath} |`)
      }
    }
  }

  if (rows.length === 0) return ''
  return [
    '## 🔌 API Endpoints',
    '',
    '| Método | Path |',
    '|---|---|',
    ...rows,
    '',
    `_${rows.length} endpoint${rows.length === 1 ? '' : 's'} no total_`
  ].join('\n')
}

function gifSection(): string {
  /*
   * Optional chaining: danger.github is undefined under `danger local` (no real PR exists in
   * that mode) — reading .pr off it would throw synchronously during module evaluation, which
   * skips Danger's runAllScheduledTasks() entirely and silently breaks every schedule()-based
   * check in this file, not just this one.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- danger.github can be undefined at runtime (danger local mode) despite being typed as non-null
  const body = danger.github?.pr?.body
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, sonarjs/different-types-comparison -- body's static type is always `string` because danger.github is (wrongly) typed non-null, but it's genuinely `undefined` at runtime under `danger local`
  if (body === undefined) return ''
  return body.includes('.gif') ? '' : '⚠️ Essa PR não tem gif na descrição. Considere adicionar um.'
}

function sourceWithoutTestWarning(): void {
  const changedFiles = [...danger.git.modified_files, ...danger.git.created_files]
  const sourceFiles = changedFiles.filter(
    (file) => /\/(?:application|domain)\//.test(file) && !file.includes('/__tests__/')
  )

  const withoutTest = sourceFiles.filter((sourceFile) => {
    const lastSlash = sourceFile.lastIndexOf('/')
    const directory = sourceFile.slice(0, lastSlash)
    const fileName = sourceFile.slice(lastSlash + 1)
    const baseName = fileName.replace(/\.ts$/, '')
    const testPrefix = `${directory}/__tests__/${baseName}.`
    return changedFiles.every((file) => !file.startsWith(testPrefix) || !file.endsWith('.ts'))
  })

  if (withoutTest.length === 0) return
  const fileList = withoutTest.map((file) => `- \`${file}\``).join('\n')
  warn(
    `Os arquivos abaixo mudaram em \`application/\`/\`domain/\` sem um teste correspondente no mesmo diff:\n${fileList}`
  )
}

const LARGE_PR_LINE_THRESHOLD = 500

function largePrWarning(): void {
  /*
   * Same runtime/type mismatch as gifSection() above: danger.github is undefined under `danger
   * local` (no real PR context), so this guards against a synchronous throw here discarding the
   * whole dangerfile report — the exact bug class the previous wave's final review found and
   * fixed for gifSection().
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- danger.github can be undefined at runtime (danger local mode) despite being typed as non-null
  const pr = danger.github?.pr
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, sonarjs/different-types-comparison -- pr's static type is always non-undefined because danger.github is (wrongly) typed non-null, but it's genuinely undefined at runtime under `danger local`
  if (pr === undefined) return
  const totalLines = pr.additions + pr.deletions
  if (totalLines <= LARGE_PR_LINE_THRESHOLD) return
  warn(
    `Esta PR tem ${totalLines} linhas alteradas (limite sugerido: ${LARGE_PR_LINE_THRESHOLD}). Considere quebrar em PRs menores para facilitar a review.`
  )
}

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

// eslint-disable-next-line unicorn/consistent-boolean-name -- semantic name aligns with CODEOWNERS pattern matching semantics
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
      /*
       * `number` on GitHubAPIPR is deprecated in favor of `pull_number`, confirmed reading
       * danger's own GitHubDSL.d.ts — the Octokit `addLabels` param is `issue_number`, but a
       * PR's number and its underlying issue number are the same value on GitHub.
       */
      issue_number: danger.github.thisPR.pull_number,
      labels: [...labels]
    })
  } catch (error: unknown) {
    warn(`Não consegui aplicar labels automáticas: ${String(error)}`)
  }
}

noTestShortcuts({
  testFilePredicate: (filePath) => /\.(?:unit|int|e2e)\.ts$/.test(filePath),
  skippedTests: 'fail'
})

sourceWithoutTestWarning()
largePrWarning()

/*
 * todos() is async — schedule() is danger's own hook for that, confirmed from the plugin's
 * own README usage example, not assumed.
 *
 * danger-plugin-todos never reports anything from a brand-new file (only additions, no
 * removals) — the plugin needs both added and removed lines in a file's diff to register a
 * match, even when the new code has a marker comment on line one. Confirmed by reading the
 * plugin's own dist source, not assumed.
 */
schedule(
  // eslint-disable-next-line unicorn/prefer-await, unicorn/prefer-top-level-await -- schedule() needs a promise handle, not real await: dangerfile.ts transpiles to CommonJS (see interop comment above), where top-level await isn't valid syntax
  todos().catch((error: unknown) => {
    warn(`danger-plugin-todos falhou: ${String(error)}`)
  })
)

/*
 * '**' would also be true for the report file's path as seen through every workspace package's
 * own node_modules/@ruguin/* symlink to it (pnpm links every dependency of every workspace
 * package this way), so the same physical report gets glob-matched once per symlink and each of
 * its violations gets reported that many times over. Verified empirically: with '**' this
 * repo's own report at packages/utils/eslint-checkstyle-report.xml resolved 7 times (6 dependent
 * packages' symlinks + the real path) for 2 violations, i.e. 14 duplicate annotations. The CI
 * step generates one report per workspace member's own root (see pnpm-workspace.yaml), so
 * anchoring the mask to those three root globs finds each report exactly once without
 * descending into any node_modules.
 */
schedule(
  lintReport
    .scan({
      fileMask: '{apps,packages,configs}/*/eslint-checkstyle-report.xml',
      reportSeverity: true,
      requireLineModification: true
    })
    // eslint-disable-next-line unicorn/prefer-await, unicorn/prefer-top-level-await -- schedule() needs a promise handle, not real await: dangerfile.ts transpiles to CommonJS (see interop comment above), where top-level await isn't valid syntax
    .catch((error: unknown) => {
      warn(`danger-plugin-lint-report falhou: ${String(error)}`)
    })
)

/*
 * Only the GitHub API call inside applyAreaLabels() is wrapped in try/catch; the synchronous
 * prelude (spreading danger.git arrays, building the labels Set) cannot throw: those arrays
 * are always populated in every Danger mode.
 */
// eslint-disable-next-line unicorn/prefer-top-level-await -- schedule() needs a promise handle, not real await: dangerfile.ts transpiles to CommonJS (see interop comment above), where top-level await isn't valid syntax
schedule(applyAreaLabels())

const sections = [
  coverageSection(),
  featuresSection(),
  endpointsSection(),
  gifSection(),
  suggestedReviewersSection()
].filter((section) => section !== '')
if (sections.length > 0) markdown(sections.join('\n\n'))
