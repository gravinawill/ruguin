import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig(
  {
    overrides: {
      unicorn: {
        /*
         * `ExecFn` is imported as a type across gitnexus-checks.ts, ruflo-checks.ts, and
         * pre-commit-checks.ts — renaming to `ExecFunction` would ripple across all three
         * for no real clarity gain.
         */
        'unicorn/name-replacements': ['error', { replacements: { repository: false, fn: false } }],
        /*
         * `complexityRegressed`/`dependenciesRegressed` are exported from baseline.ts and
         * imported by ruflo-checks.ts and read throughout baseline.unit.ts — renaming would
         * ripple across all three for no real clarity gain. Scoped to just these two names
         * (not a blanket rule-off) via the rule's own `ignore` option.
         */
        'unicorn/consistent-boolean-name': ['error', { ignore: ['^complexityRegressed$', '^dependenciesRegressed$'] }]
      }
    }
  },
  {
    /*
     * `main()` in pre-commit-checks.ts and claude-precommit-gate.ts are CLI entrypoints invoked
     * directly by Husky and the Claude PreToolUse hook respectively; both must signal pass/fail
     * to the calling shell via process exit codes.
     */
    files: ['src/pre-commit-checks.ts', 'src/claude-precommit-gate.ts'],
    rules: {
      'unicorn/no-process-exit': 'off'
    }
  },
  {
    /*
     * index.ts is intentionally a comment-only placeholder describing the package layout —
     * its real public entrypoints are designed in a later task, not this remediation.
     */
    files: ['src/index.ts'],
    rules: {
      'unicorn/no-empty-file': ['error', { allowComments: true }]
    }
  }
)
