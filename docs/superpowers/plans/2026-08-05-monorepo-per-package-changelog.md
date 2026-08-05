# Monorepo Per-Package Changelog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of the 11 real workspaces (`apps/*`, `packages/*`, `configs/*`) its own
independent semantic version, tag, `CHANGELOG.md`, and GitHub Release — driven automatically by
`@anolilab/multi-semantic-release`, replacing the single monorepo-wide `v*` tag — plus a generated
index in the root `CHANGELOG.md` linking to whichever packages changed in each release run.

**Architecture:** A shared `release.config.base.mjs` module exports the conventional-commits
preset (matching `dangerfile.ts`'s `COMMIT_TYPE_LABELS`); each workspace gets a `.releaserc.mjs`
that imports it and adds its own plugin list (changelog, GitHub release, git commit-back — no npm
publish anywhere). `.multi-releaserc.json` at the root configures `ignorePrivate: false` so all 11
workspaces participate, not just the 6 non-private ones. `.github/workflows/release.yml` swaps
`semantic-release` for `multi-semantic-release`, then runs a small aggregation script that diffs
git tags before/after the run and appends a dated index entry to the root `CHANGELOG.md`.
`release-image.yml`'s tag trigger moves from `v*` to `@ruguin/core-server@*`.

**Tech Stack:** `@anolilab/multi-semantic-release` (`^4.4.6`), `semantic-release` (already a root
devDependency, `25.0.8`), `conventional-changelog-conventionalcommits` (already an installed
transitive dependency, resolved by `preset: 'conventionalcommits'`).

## Global Constraints

- 11 real workspaces, not 12: `apps/core-server` (`@ruguin/core-server`), `apps/dispatch-worker`
  (`@ruguin/dispatch-worker`), `packages/cache` (`@ruguin/cache`), `packages/env` (`@ruguin/env`),
  `packages/event-schemas` (`@ruguin/event-schemas`), `packages/message-broker`
  (`@ruguin/message-broker`), `packages/shared-domain` (`@ruguin/shared-domain`),
  `packages/utils` (`@ruguin/utils`), `configs/eslint-config` (`@ruguin/eslint-config`),
  `configs/prettier-config` (`@ruguin/prettier-config`), `configs/typescript-config`
  (`@ruguin/typescript-config`). `packages/ddd-kernel` does not exist (renamed to
  `packages/shared-domain`) — never create a config for it.
- Tag format is `${name}@${version}` with the npm scope included (confirmed empirically:
  `@ruguin/core-server@1.0.0`, not `core-server@1.0.0`).
- No `@semantic-release/npm` in any package's plugin list — nothing is published to any registry
  (confirmed decision, unrelated to today's `private` field values, which stay as they are).
  `configs/*`'s existing `publishConfig.access: "public"` fields stay untouched, unused, same as
  today.
- Every package DOES get `@semantic-release/github` (creates a GitHub Release per package per
  bump) — a confirmed decision, not the leaner "just tag + CHANGELOG.md" alternative.
- `branches` is never set to `["*"]` in any new config file — confirmed via the spike that this
  repository's `git worktree`-heavy workflow exceeds `semantic-release`'s 3-branch cap
  (`ERELEASEBRANCHES`). Every new per-package `.releaserc.mjs` in this plan omits `branches`
  entirely and inherits `["master"]` from the existing root `.releaserc.json` via cosmiconfig's
  package-to-root fallback (confirmed: this fallback is exactly what blocked round 1 of the spike,
  proving the inheritance is real, not assumed).
- `.multi-releaserc.json` (MSR's own config file, resolved via cosmiconfig module name
  `"multi-release"`) is a different, non-colliding namespace from the existing root
  `.releaserc.json` (resolved via cosmiconfig module name `"release"`) — confirmed via reading
  both tools' source. Never merge the two files.
- Every per-package config file is named `.releaserc.mjs` (not `.releaserc.json`) because it needs
  to `import` the shared `release.config.base.mjs` module — confirmed via reading the installed
  `cosmiconfig` package's default search places (`.${moduleName}rc.mjs` is one of them for
  `semantic-release`'s own `"release"` module name) that this file name is recognized natively,
  not a guess.

---

### Task 1: Shared preset module, MSR config, and all 11 per-package release configs

**Files:**

- Create: `release.config.base.mjs`
- Create: `.multi-releaserc.json`
- Modify: `package.json` (add `@anolilab/multi-semantic-release` devDependency)
- Create: `apps/core-server/.releaserc.mjs`
- Create: `apps/dispatch-worker/.releaserc.mjs`
- Create: `packages/cache/.releaserc.mjs`
- Create: `packages/env/.releaserc.mjs`
- Create: `packages/event-schemas/.releaserc.mjs`
- Create: `packages/message-broker/.releaserc.mjs`
- Create: `packages/shared-domain/.releaserc.mjs`
- Create: `packages/utils/.releaserc.mjs`
- Create: `configs/eslint-config/.releaserc.mjs`
- Create: `configs/prettier-config/.releaserc.mjs`
- Create: `configs/typescript-config/.releaserc.mjs`

**Interfaces:**

- Produces: `release.config.base.mjs` exports `releasePreset` (an object with `preset` and
  `presetConfig` keys) — every `.releaserc.mjs` created in this task imports it via the relative
  path `../../release.config.base.mjs` (every workspace is exactly two directories deep:
  `apps/X`, `packages/X`, `configs/X`, so this relative path is identical across all 11 files).

- [ ] **Step 1: Create the shared preset module**

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

- [ ] **Step 2: Create the MSR-specific config**

```json
{
  "ignorePrivate": false
}
```

Save as `.multi-releaserc.json` at the repo root. Without this, MSR's own default
(`ignorePrivate: true`) would silently exclude `packages/cache`, `packages/event-schemas`,
`packages/message-broker`, `packages/shared-domain`, and `packages/utils` (all `"private": true`)
from every run.

- [ ] **Step 3: Add the real devDependency**

```bash
pnpm add -D @anolilab/multi-semantic-release@^4.4.6
```

- [ ] **Step 4: Create each of the 11 per-package `.releaserc.mjs` files**

The content is identical across all 11 — same relative import path (every workspace is exactly
two directories deep), same plugin list. Create each of these 11 files with this exact content:

`apps/core-server/.releaserc.mjs`, `apps/dispatch-worker/.releaserc.mjs`,
`packages/cache/.releaserc.mjs`, `packages/env/.releaserc.mjs`,
`packages/event-schemas/.releaserc.mjs`, `packages/message-broker/.releaserc.mjs`,
`packages/shared-domain/.releaserc.mjs`, `packages/utils/.releaserc.mjs`,
`configs/eslint-config/.releaserc.mjs`, `configs/prettier-config/.releaserc.mjs`,
`configs/typescript-config/.releaserc.mjs`:

```js
import { releasePreset } from '../../release.config.base.mjs'

export default {
  plugins: [
    ['@semantic-release/commit-analyzer', releasePreset],
    ['@semantic-release/release-notes-generator', releasePreset],
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    '@semantic-release/github',
    [
      '@semantic-release/git',
      { assets: ['CHANGELOG.md', 'package.json'], message: 'chore(release): ${nextRelease.version}' }
    ]
  ]
}
```

`package.json` is in `assets` (unlike the root `.releaserc.json`'s `@semantic-release/git`, which
only commits `CHANGELOG.md`) because here it's the file carrying the actual version bump that
matters — MSR writes the correct version into each package's `package.json` during its own
"prepare" step, and this is what commits that write back to git.

- [ ] **Step 5: Verify every config resolves and parses correctly**

```bash
for dir in apps/core-server apps/dispatch-worker packages/cache packages/env \
  packages/event-schemas packages/message-broker packages/shared-domain packages/utils \
  configs/eslint-config configs/prettier-config configs/typescript-config; do
  node -e "
    import('./$dir/.releaserc.mjs').then((m) => {
      if (!Array.isArray(m.default.plugins) || m.default.plugins.length !== 5) {
        throw new Error('$dir: unexpected plugins shape');
      }
      console.log('$dir: OK, ' + m.default.plugins.length + ' plugins');
    });
  "
done
```

Expected: 11 lines, each `<dir>: OK, 5 plugins` — confirms every file is valid ESM, the import
resolves, and the shared preset object made it into the plugin list correctly.

- [ ] **Step 6: Dry-run against the real, permanent config**

```bash
pnpm exec multi-semantic-release --dry-run 2>&1 | tee /tmp/msr-real-dry-run.txt
echo "Exit code: $?"
grep -c "^\[.*\]" /tmp/msr-real-dry-run.txt || true
```

Expected: exit 0. Unlike the spike (which used a disposable config), this dry run uses the real,
permanent files created in this task — confirms the actual shipped config works, not a
throwaway one. If any package errors (missing plugin, bad import, etc.), fix it here before
moving on — this is the last checkpoint before the aggregation script (Task 2) and CI wiring
(Task 3) start depending on this configuration being correct.

- [ ] **Step 7: Clean up the dry-run artifact and commit**

```bash
rm -f /tmp/msr-real-dry-run.txt
git add release.config.base.mjs .multi-releaserc.json package.json pnpm-lock.yaml \
  apps/core-server/.releaserc.mjs apps/dispatch-worker/.releaserc.mjs \
  packages/cache/.releaserc.mjs packages/env/.releaserc.mjs \
  packages/event-schemas/.releaserc.mjs packages/message-broker/.releaserc.mjs \
  packages/shared-domain/.releaserc.mjs packages/utils/.releaserc.mjs \
  configs/eslint-config/.releaserc.mjs configs/prettier-config/.releaserc.mjs \
  configs/typescript-config/.releaserc.mjs
git commit -m "feat(release): add per-package semantic-release configs

Each of the 11 real workspaces gets its own .releaserc.mjs importing a
shared conventionalcommits preset (release.config.base.mjs), matching
dangerfile.ts's COMMIT_TYPE_LABELS. .multi-releaserc.json turns off
multi-semantic-release's default private-package exclusion so all 11
participate, not just the 6 non-private ones."
```

---

### Task 2: Root changelog aggregation script

**Files:**

- Create: `scripts/aggregate-changelog.mjs`

**Interfaces:**

- Consumes: a file path (argv[2]) containing the newline-separated list of git tags that existed
  *before* the `multi-semantic-release` run — Task 3's CI wiring produces this file.
- Produces: an updated root `CHANGELOG.md`, with a new dated section listing whichever packages
  got a new tag in the run this script is called for.

- [ ] **Step 1: Create the aggregation script**

```js
#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// Kept as an explicit map (not derived from pnpm-workspace.yaml at runtime) because this script
// only needs to resolve the 11 known package names to their directories for a changelog link —
// YAGNI to add a workspace-scanning dependency for that. Keep in sync with Global Constraints'
// workspace list if a workspace is ever added, renamed, or removed.
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
const afterTags = execSync('git tag --list', { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
const newTags = afterTags.filter((tag) => !beforeTags.has(tag))

if (newTags.length === 0) {
  console.log('No new package tags this run — nothing to aggregate.')
  process.exit(0)
}

const TAG_PATTERN = /^(@ruguin\/[a-z0-9-]+)@(\d+\.\d+\.\d+.*)$/
const entries = newTags
  .map((tag) => {
    const match = tag.match(TAG_PATTERN)
    if (!match) return null
    const [, packageName, version] = match
    const dirPath = PACKAGE_PATHS[packageName]
    if (!dirPath) return null
    return { packageName, version, dirPath }
  })
  .filter(Boolean)

if (entries.length === 0) {
  console.log('New tags found, but none matched a known package — nothing to aggregate.')
  process.exit(0)
}

const date = new Date().toISOString().slice(0, 10)
const lines = entries.map(
  ({ packageName, version, dirPath }) =>
    `- **${packageName}@${version}** — [CHANGELOG.md](https://github.com/gravinawill/ruguin/blob/master/${dirPath}/CHANGELOG.md)`
)

const rootChangelogPath = 'CHANGELOG.md'
const existing = existsSync(rootChangelogPath) ? readFileSync(rootChangelogPath, 'utf8') : '# Changelog\n\n'
const entry = `## ${date}\n\n${lines.join('\n')}\n\n`
const updated = existing.startsWith('# Changelog\n\n')
  ? existing.replace('# Changelog\n\n', `# Changelog\n\n${entry}`)
  : `# Changelog\n\n${entry}${existing}`

writeFileSync(rootChangelogPath, updated)
console.log(`Aggregated ${entries.length} package(s) into ${rootChangelogPath}:`)
for (const line of lines) console.log(`  ${line}`)
```

- [ ] **Step 2: Write a real test of the script's core logic**

Create `scripts/__tests__/aggregate-changelog.unit.ts`:

```ts
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('aggregate-changelog script', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'aggregate-changelog-test-'))
    execSync('git init -q', { cwd: repoDir })
    execSync('git config user.email test@example.com', { cwd: repoDir })
    execSync('git config user.name Test', { cwd: repoDir })
    writeFileSync(join(repoDir, 'placeholder.txt'), 'x')
    execSync('git add placeholder.txt && git commit -q -m init', { cwd: repoDir })
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('appends a dated entry for a newly-tagged known package', () => {
    execSync('git tag "@ruguin/env@0.1.0"', { cwd: repoDir })
    const beforeTagsFile = join(repoDir, 'before-tags.txt')
    writeFileSync(beforeTagsFile, '')

    execSync(`node ${join(import.meta.dirname, '..', 'aggregate-changelog.mjs')} "${beforeTagsFile}"`, {
      cwd: repoDir
    })

    const changelog = readFileSync(join(repoDir, 'CHANGELOG.md'), 'utf8')
    expect(changelog).toContain('@ruguin/env@0.1.0')
    expect(changelog).toContain('packages/env/CHANGELOG.md')
  })

  it('does nothing when no new tags exist', () => {
    const beforeTagsFile = join(repoDir, 'before-tags.txt')
    writeFileSync(beforeTagsFile, '')

    execSync(`node ${join(import.meta.dirname, '..', 'aggregate-changelog.mjs')} "${beforeTagsFile}"`, {
      cwd: repoDir
    })

    expect(existsSync(join(repoDir, 'CHANGELOG.md'))).toBe(false)
  })

  it('ignores a new tag that does not match a known package name', () => {
    execSync('git tag "v1.2.3"', { cwd: repoDir })
    const beforeTagsFile = join(repoDir, 'before-tags.txt')
    writeFileSync(beforeTagsFile, '')

    execSync(`node ${join(import.meta.dirname, '..', 'aggregate-changelog.mjs')} "${beforeTagsFile}"`, {
      cwd: repoDir
    })

    expect(existsSync(join(repoDir, 'CHANGELOG.md'))).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails first, then passes**

Run: `pnpm exec vitest run scripts/__tests__/aggregate-changelog.unit.ts`

Before Step 1's script exists, this fails with a module-not-found error. After Step 1's script is
in place, run again — expected: 3 passed, 0 failed.

- [ ] **Step 4: Commit**

```bash
git add scripts/aggregate-changelog.mjs scripts/__tests__/aggregate-changelog.unit.ts
git commit -m "feat(release): add root changelog aggregation script

Diffs git tags before/after a multi-semantic-release run and appends a
dated index entry to the root CHANGELOG.md linking to each newly-tagged
package's own CHANGELOG.md — the one piece of this feature entirely
under our own control, kept small and directly tested."
```

---

### Task 3: Wire CI — `release.yml` and `release-image.yml`

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/release-image.yml`

**Interfaces:**

- Consumes: `scripts/aggregate-changelog.mjs` (Task 2), the 11 `.releaserc.mjs` files and
  `.multi-releaserc.json` (Task 1).

- [ ] **Step 1: Swap `semantic-release` for `multi-semantic-release`, add the aggregation step**

In `.github/workflows/release.yml`, find:

```yaml
      - name: Release
        run: pnpm exec semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Replace with:

```yaml
      - name: Record tags before release
        run: git tag --list > /tmp/tags-before.txt

      - name: Release
        run: pnpm exec multi-semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Aggregate changelog
        run: |
          node scripts/aggregate-changelog.mjs /tmp/tags-before.txt
          git diff --quiet -- CHANGELOG.md && exit 0
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add CHANGELOG.md
          git commit -m "chore(changelog): aggregate this run's package releases"
          for attempt in 1 2 3; do
            echo "Push attempt $attempt/3..."
            if git push; then
              exit 0
            fi
            git pull --rebase origin "${GITHUB_REF_NAME}"
          done
          exit 1
```

The retry-with-rebase pattern matches `release-image.yml`'s `promote` job (from the immutable-tags
wave) — the same class of race is possible here: `multi-semantic-release`'s own
`@semantic-release/git` commits (one push per package that released) happen in this same job
immediately before this step, so this step's own push could just as easily race against a
concurrent push to `master` from something else.

- [ ] **Step 2: Validate the workflow**

```bash
actionlint .github/workflows/release.yml
```

Expected: no output, exit code 0.

- [ ] **Step 3: Update `release-image.yml`'s tag trigger**

In `.github/workflows/release-image.yml`, find:

```yaml
on:
  push:
    branches: [master, develop]
    tags: ['v*']
    paths-ignore: ['infrastructure/k8s/**']
```

Replace with:

```yaml
on:
  push:
    branches: [master, develop]
    tags: ['@ruguin/core-server@*']
    paths-ignore: ['infrastructure/k8s/**']
```

- [ ] **Step 4: Also update `docker/metadata-action`'s semver tag pattern**

In the same file, find:

```yaml
          tags: |
            type=sha,prefix=sha-,format=long
            type=semver,pattern={{version}}
            type=raw,value=latest,enable={{is_default_branch}}
```

Replace with:

```yaml
          tags: |
            type=sha,prefix=sha-,format=long
            type=raw,value=latest,enable={{is_default_branch}}
```

The `type=semver,pattern={{version}}` line only ever matched the old `v*`-tagged releases — since
those never actually triggered this workflow in practice (`GITHUB_TOKEN`-authored pushes don't
fire `push` events, a pre-existing, unrelated finding from the immutable-tags wave's final
review), this line was already dead in this workflow. `@ruguin/core-server@1.2.3` doesn't match
`docker/metadata-action`'s `type=semver` pattern (which expects a bare `MAJOR.MINOR.PATCH` tag,
optionally prefixed with `v`), so keeping the line would silently produce zero tags from it
instead of the image version tag someone might expect it to produce — removing it is more honest
than leaving a rule that can never match anything now.

- [ ] **Step 5: Validate the workflow**

```bash
actionlint .github/workflows/release-image.yml
```

Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/release-image.yml
git commit -m "feat(ci): run multi-semantic-release and aggregate the changelog

release.yml now runs multi-semantic-release instead of semantic-release,
then aggregate-changelog.mjs. release-image.yml's tag trigger moves from
the old monorepo-wide v* to @ruguin/core-server@*, matching the new
per-package tag format — also drops docker/metadata-action's now-dead
semver tag rule, which never matched anything real."
```

## Self-Review Notes

- **Spec coverage:** Decision 1 (tool) → already installed by the spike, made permanent in Task 1
  Step 3. Decision 2 (shared module) → Task 1 Step 1. Decision 3 (no publish) → Task 1 Step 4 (no
  `@semantic-release/npm` anywhere). Decision 4 (tag format) → confirmed, consumed directly by
  Task 3 Step 3. Decision 5 (aggregation) → Task 2. Decision 6 (CI trigger) → Task 3 Steps 3-4.
  Decision 7 (all 11 participate, `ignorePrivate`) → Task 1 Step 2. Decision 8 (spike) → already
  complete, this whole plan is its consequence. Decision 9 (explicit branches) → Global
  Constraints + Task 1 Step 4 (no `branches` field in any new file, inherits `["master"]`).
- **No placeholders:** every file's full content is given — the shared module, the MSR config, all
  11 identical per-package configs, the full aggregation script, its test, and the exact workflow
  diffs. The one thing this plan cannot verify in advance is a real (non-dry-run)
  `multi-semantic-release` execution actually creating 11 tags and pushing successfully in CI —
  same category of limitation as every other infra wave this session (no live credentials in this
  environment); Task 1 Step 6's real-config dry run is the closest verification achievable here.
- **Type/interface consistency:** the aggregation script's `PACKAGE_PATHS` map uses the exact same
  11 package names Task 1 creates configs for — verified against the real `package.json` `name`
  fields read directly from each workspace during planning, not assumed from directory names.
