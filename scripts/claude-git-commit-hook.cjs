#!/usr/bin/env node
// scripts/claude-git-commit-hook.cjs
const { execFileSync } = require('node:child_process')

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
      execFileSync('npx', ['tsx', 'packages/precommit-checks/src/claude-precommit-gate.ts'], { stdio: 'inherit' })
      process.exit(0)
    } catch (error) {
      process.exit(error.status ?? 2)
    }
  })
}

main()
