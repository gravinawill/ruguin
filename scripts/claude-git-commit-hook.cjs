#!/usr/bin/env node
// scripts/claude-git-commit-hook.cjs
const { execFileSync } = require('node:child_process')
const path = require('node:path')

/*
 * Resolved relative to this file (not `process.cwd()`), consistent with `.claude/settings.json`'s
 * use of `${CLAUDE_PROJECT_DIR:-.}` and this codebase's other entrypoints (which resolve via
 * `import.meta.url`). If cwd is ever something other than the repo root, a bare relative string
 * like `'packages/precommit-checks/src/claude-precommit-gate.ts'` would throw ENOENT here.
 */
const gatePath = path.resolve(__dirname, '..', 'packages/precommit-checks/src/claude-precommit-gate.ts')

function main() {
  const chunks = []
  process.stdin.on('data', (chunk) => {
    chunks.push(chunk)
  })

  process.stdin.on('end', () => {
    let command = ''
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      command = payload?.tool_input?.command ?? ''
    } catch {
      process.exit(0)
    }

    const isGitCommit = command.split('\n').some((line) => /(?:^|[;|]|&&)\s*git\s+commit(?:\s|$)/.test(line))

    if (!isGitCommit) {
      process.exit(0)
    }

    try {
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- `npx`/`tsx` resolve via PATH by design; trusted, well-known project tooling, not user input.
      execFileSync('npx', ['tsx', gatePath], { stdio: 'inherit' })
      process.exit(0)
    } catch (error) {
      /*
       * `stdio: 'inherit'` only forwards the CHILD's own stdout/stderr — if the child never
       * started (e.g. ENOENT from a bad path), nothing gets printed anywhere. Log here so a
       * real failure is never silent.
       */
      console.error('claude-git-commit-hook: failed to run the gate:', error.message)
      process.exit(error.status ?? 2)
    }
  })
}

main()
