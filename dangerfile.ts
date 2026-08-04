import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { danger, markdown } from 'danger'

type CoverageMetric = 'statements' | 'branches' | 'functions' | 'lines'
type CoverageSummary = { total: Record<CoverageMetric, { pct: number }> }
type Thresholds = Record<CoverageMetric, number>

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
  const hasGif = (danger.github.pr.body || '').includes('.gif')
  if (hasGif) return ''
  return '⚠️ Essa PR não tem gif na descrição. Considere adicionar um.'
}

const sections = [coverageSection(), featuresSection(), endpointsSection(), gifSection()].filter(
  (section) => section !== ''
)
if (sections.length > 0) markdown(sections.join('\n\n'))
