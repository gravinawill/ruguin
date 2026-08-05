import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/*
 * A parent `git` hook (e.g. husky's pre-commit) can run this suite with `GIT_DIR`/`GIT_INDEX_FILE`
 * already pointed at the real repo's index. Since execSync inherits process.env by default, that
 * would redirect the commands below away from the throwaway repoDirectory below and onto the real
 * one, so those variables are stripped for every command this test runs.
 */
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))

/*
 * Single choke point for shelling out in this test: every command below is a fixed, hardcoded
 * binary (git/node) run against a throwaway temp repo, not attacker-controlled input.
 */
const run = (command: string, cwd: string): void => {
  execSync(command, { cwd, env: environment })
}

describe('aggregate-changelog script', () => {
  let repoDirectory: string

  beforeEach(() => {
    repoDirectory = mkdtempSync(path.join(tmpdir(), 'aggregate-changelog-test-'))
    run('git init -q', repoDirectory)
    run('git config user.email test@example.com', repoDirectory)
    run('git config user.name Test', repoDirectory)
    /*
     * Isolate from the host's global git config: a machine with `tag.gpgSign=true` turns every
     * `git tag` below into an annotated/signed tag, which then fails with "no tag message?".
     */
    run('git config tag.gpgSign false', repoDirectory)
    writeFileSync(path.join(repoDirectory, 'placeholder.txt'), 'x')
    run('git add placeholder.txt && git commit -q -m init', repoDirectory)
  })

  afterEach(() => {
    rmSync(repoDirectory, { recursive: true, force: true })
  })

  it('appends a dated entry for a newly-tagged known package', () => {
    run('git tag "@ruguin/env@0.1.0"', repoDirectory)
    const beforeTagsFile = path.join(repoDirectory, 'before-tags.txt')
    writeFileSync(beforeTagsFile, '')

    run(`node ${path.join(import.meta.dirname, '..', 'aggregate-changelog.mjs')} "${beforeTagsFile}"`, repoDirectory)

    const changelog = readFileSync(path.join(repoDirectory, 'CHANGELOG.md'), 'utf8')
    expect(changelog).toContain('@ruguin/env@0.1.0')
    expect(changelog).toContain('packages/env/CHANGELOG.md')
  })

  it('does nothing when no new tags exist', () => {
    const beforeTagsFile = path.join(repoDirectory, 'before-tags.txt')
    writeFileSync(beforeTagsFile, '')

    run(`node ${path.join(import.meta.dirname, '..', 'aggregate-changelog.mjs')} "${beforeTagsFile}"`, repoDirectory)

    expect(existsSync(path.join(repoDirectory, 'CHANGELOG.md'))).toBe(false)
  })

  it('ignores a new tag that does not match a known package name', () => {
    run('git tag "v1.2.3"', repoDirectory)
    const beforeTagsFile = path.join(repoDirectory, 'before-tags.txt')
    writeFileSync(beforeTagsFile, '')

    run(`node ${path.join(import.meta.dirname, '..', 'aggregate-changelog.mjs')} "${beforeTagsFile}"`, repoDirectory)

    expect(existsSync(path.join(repoDirectory, 'CHANGELOG.md'))).toBe(false)
  })
})
