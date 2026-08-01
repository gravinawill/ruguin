/*
 * Deterministic pre-commit checks (GitNexus + ruflo).
 *
 * Entrypoints in src/ root:
 *   - pre-commit-checks.ts: Main Husky hook entrypoint for every commit
 *   - claude-precommit-gate.ts: Claude PreToolUse hook entrypoint for agentic review gate
 *   - mark-review-done.ts: Called after Claude completes agentic review
 *
 * Lib modules in src/lib/: gitnexus-checks, ruflo-checks, baseline, precommit-state, git, extract-json.
 */
