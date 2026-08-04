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

noTestShortcuts({
  testFilePredicate: (filePath) => /\.(?:unit|int|e2e)\.ts$/.test(filePath),
  skippedTests: 'fail'
})

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

const sections = [coverageSection(), featuresSection(), endpointsSection(), gifSection()].filter(
  (section) => section !== ''
)
if (sections.length > 0) markdown(sections.join('\n\n'))
