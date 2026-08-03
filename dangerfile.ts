import { existsSync, readFileSync } from 'node:fs'

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
  const pick = (key: CoverageMetric): number => {
    const found = new RegExp(String.raw`${key}:\s*(\d+)`).exec(body)
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

const sections = [coverageSection(), featuresSection()].filter((section) => section !== '')
if (sections.length > 0) markdown(sections.join('\n\n'))
