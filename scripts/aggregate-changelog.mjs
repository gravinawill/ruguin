#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/*
 * Kept as an explicit map (not derived from pnpm-workspace.yaml at runtime) because this script
 * only needs to resolve the 11 known package names to their directories for a changelog link —
 * YAGNI to add a workspace-scanning dependency for that. Keep in sync with Global Constraints'
 * workspace list if a workspace is ever added, renamed, or removed.
 */
const PACKAGE_PATHS = {
  '@ruguin/core-server': 'apps/core-server',
  '@ruguin/dispatch-worker': 'apps/dispatch-worker',
  '@ruguin/cache': 'packages/cache',
  '@ruguin/env': 'packages/env',
  '@ruguin/event-schemas': 'packages/event-schemas',
  '@ruguin/message-broker': 'packages/message-broker',
  '@ruguin/shared-domain': 'packages/shared-domain',
  '@ruguin/utils': 'packages/utils',
  '@ruguin/eslint-config': 'configs/eslint-config',
  '@ruguin/prettier-config': 'configs/prettier-config',
  '@ruguin/typescript-config': 'configs/typescript-config'
}

const beforeTagsFile = process.argv[2]
if (!beforeTagsFile) {
  console.error('Usage: aggregate-changelog.mjs <before-tags-file>')
  process.exit(1)
}

const beforeTags = new Set(readFileSync(beforeTagsFile, 'utf8').trim().split('\n').filter(Boolean))
// eslint-disable-next-line sonarjs/no-os-command-from-path -- fixed, hardcoded `git` invocation, not attacker-controlled input
const afterTags = execSync('git tag --list', { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
const newTags = afterTags.filter((tag) => !beforeTags.has(tag))

if (newTags.length === 0) {
  console.log('No new package tags this run — nothing to aggregate.')
  process.exit(0)
}

const TAG_PATTERN = /^(@ruguin\/[a-z0-9-]+)@(\d+\.\d+\.\d.*)$/
const entries = newTags
  .map((tag) => {
    const match = tag.match(TAG_PATTERN)
    if (!match) return null
    const [, packageName, version] = match
    const directoryPath = PACKAGE_PATHS[packageName]
    if (!directoryPath) {
      console.warn(
        `::warning::${tag} looks like a package tag but has no entry in PACKAGE_PATHS — skipped from the aggregated changelog.`
      )
      return null
    }
    return { packageName, version, directoryPath }
  })
  .filter(Boolean)

if (entries.length === 0) {
  console.log('New tags found, but none matched a known package — nothing to aggregate.')
  process.exit(0)
}

const date = new Date().toISOString().slice(0, 10)
const lines = entries.map(
  ({ packageName, version, directoryPath }) =>
    `- **${packageName}@${version}** — [CHANGELOG.md](https://github.com/gravinawill/ruguin/blob/master/${directoryPath}/CHANGELOG.md)`
)

const rootChangelogPath = 'CHANGELOG.md'
const existing = existsSync(rootChangelogPath) ? readFileSync(rootChangelogPath, 'utf8') : '# Changelog\n\n'
const entry = `## ${date}\n\n${lines.join('\n')}\n\n`
const updated = existing.startsWith('# Changelog\n\n')
  ? existing.replace('# Changelog\n\n', () => `# Changelog\n\n${entry}`)
  : `# Changelog\n\n${entry}${existing}`

writeFileSync(rootChangelogPath, updated)
console.log(`Aggregated ${entries.length} package(s) into ${rootChangelogPath}:`)
for (const line of lines) console.log(`  ${line}`)
