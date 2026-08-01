# CLAUDE.md

## Purpose

`@ruguin/precommit-checks` — deterministic checks (GitNexus + ruflo) that run before every `git commit`, shared between `.husky/pre-commit` (every commit) and the Claude Code `PreToolUse` hook (Claude's own commits, layering an agentic-review gate on top). See `docs/superpowers/specs/2026-07-31-full-code-analysis-precommit-gate-design.md`.

## Structure

```
src/
  lib/
    extract-json.ts        # pulls a JSON value out of noisy CLI stdout
    gitnexus-checks.ts      # check --cycles, detect-changes, impact
    ruflo-checks.ts         # analyze diff --risk, complexity, dependencies, secrets (staged-files-scoped), report-only
    baseline.ts              # .claude/pre-commit-baseline.json read/compare/write
    precommit-state.ts       # gate state (keyed by diff hash) read/write + diff hash
    git.ts                   # realExec (the real ExecFn, 30s timeout per call) + resolveGitDirectory (git rev-parse --git-dir, worktree-safe)
  pre-commit-checks.ts       # entrypoint: Husky calls this directly
  claude-precommit-gate.ts   # entrypoint: Claude PreToolUse hook calls this
  mark-review-done.ts        # entrypoint: Claude calls this after the agentic review
```

The gate state file and the precommit report file both live inside the real git directory resolved via `resolveGitDirectory` (`git rev-parse --git-dir`), not a hardcoded `.git/`  — inside a worktree, `.git` is a pointer file, not a directory.

## Rules

- No real CLI calls in `*.unit.ts` — mock `node:child_process`. Exception: `git.ts`'s own timeout-kill test spawns a real short-lived subprocess, since a signal/timeout interaction can't be meaningfully mocked.
- A tool failing, timing out, or being unavailable (missing binary, network, hung process) is a warning, never a blocking finding — every real `ExecFn` call is bounded by `realExec`'s 30s timeout so no single check can hang the whole script.
- Raw TS, no build — run via `tsx path/to/entrypoint.ts`.
