import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { realExec, resolveGitDirectory } from './lib/git'
import { computeDiffHash, type PrecommitState, readState, writeState } from './lib/precommit-state'

export function applyReviewDone(input: {
  diffHash: string
  state: PrecommitState | null
  override?: string
}): PrecommitState {
  if (!input.state) throw new Error('No gate state found — run a commit attempt first so the deterministic checks run.')
  if (input.state.diffHash !== input.diffHash) {
    throw new Error(
      'The staged diff has changed since the deterministic checks last ran — retry the commit to re-run them.'
    )
  }

  return {
    ...input.state,
    agenticReviewDone: true,
    ...(input.override && { overrideApproved: true, overrideReason: input.override })
  }
}

function main(): void {
  const repoRoot = process.cwd()
  const overrideFlagIndex = process.argv.indexOf('--override')
  const override = overrideFlagIndex === -1 ? undefined : process.argv[overrideFlagIndex + 1]

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` resolves via PATH by design; trusted, well-known project tool, not user input.
  const diffText = execFileSync('git', ['diff', '--cached'], { encoding: 'utf8' })
  const diffHash = computeDiffHash(diffText)

  const gitDirectory = resolveGitDirectory(realExec, repoRoot)
  const statePath = path.resolve(gitDirectory, '.claude-precommit-state.json')

  const nextState = applyReviewDone({ diffHash, state: readState(statePath), override })
  writeState(statePath, nextState)
  console.log(override ? `Override recorded: ${override}` : 'Agentic review recorded as done.')
}

if (!process.env.VITEST) {
  main()
}
