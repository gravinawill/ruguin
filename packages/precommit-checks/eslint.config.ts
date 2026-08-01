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
         * `CheckResult.blocking`/`.warning` (and the local `clean`) are an established
         * check-result contract read throughout this package's checks and their tests —
         * renaming would ripple widely for no real clarity gain.
         */
        'unicorn/consistent-boolean-name': 'off'
      }
    }
  },
  {
    /*
     * `main()` in pre-commit-checks.ts is a CLI entrypoint invoked directly by Husky and the
     * Claude PreToolUse hook; it must signal pass/fail to the calling shell via process exit codes.
     */
    files: ['src/pre-commit-checks.ts'],
    rules: {
      'unicorn/no-process-exit': 'off'
    }
  }
)
