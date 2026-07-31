# CLAUDE.md

## Purpose

`@ruguin/precommit-checks` — deterministic checks (GitNexus + ruflo) that run before every `git commit`, shared between `.husky/pre-commit` (every commit) and the Claude Code `PreToolUse` hook (Claude's own commits, layering an agentic-review gate on top). See `docs/superpowers/specs/2026-07-31-full-code-analysis-precommit-gate-design.md`.

## Structure

```
src/
  lib/
    extract-json.ts        # pulls a JSON value out of noisy CLI stdout
    gitnexus-checks.ts      # check --cycles, detect-changes, impact
    ruflo-checks.ts         # analyze diff --risk, complexity, dependencies, secrets, report-only
    baseline.ts              # .claude/pre-commit-baseline.json read/compare/write
    precommit-state.ts       # .git/.claude-precommit-state.json read/write + diff hash
  pre-commit-checks.ts       # entrypoint: Husky calls this directly
  claude-precommit-gate.ts   # entrypoint: Claude PreToolUse hook calls this
  mark-review-done.ts        # entrypoint: Claude calls this after the agentic review
```

## Rules

- No real CLI calls in `*.unit.ts` — mock `node:child_process`.
- A tool failing to run (missing binary, network) is a warning, never a blocking finding.
- Raw TS, no build — run via `tsx path/to/entrypoint.ts`.
