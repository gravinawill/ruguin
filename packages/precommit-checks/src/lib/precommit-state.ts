import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type PrecommitState = {
  diffHash: string
  deterministic: 'pass' | 'fail'
  agenticReviewDone: boolean
  overrideApproved: boolean
  overrideReason?: string
}

export function computeDiffHash(diffText: string): string {
  return createHash('sha256').update(diffText).digest('hex')
}

export function readState(statePath: string): PrecommitState | null {
  if (!existsSync(statePath)) return null

  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as PrecommitState
  } catch {
    return null
  }
}

export function writeState(statePath: string, state: PrecommitState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}
