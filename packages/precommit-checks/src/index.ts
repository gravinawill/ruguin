/*
 * Deterministic pre-commit checks (GitNexus + ruflo).
 * Entrypoints are in src/ root: pre-commit-checks.ts, claude-precommit-gate.ts, mark-review-done.ts.
 * Lib modules are in src/lib/.
 */

export * from './lib/baseline'
export * from './lib/extract-json'
export * from './lib/gitnexus-checks'
export * from './lib/precommit-state'
export * from './lib/ruflo-checks'
