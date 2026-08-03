/**
 * Commitlint configuration.
 *
 * Enforces the Conventional Commits specification on every commit message via
 * the `commit-msg` Husky hook. Interactive commits are authored with `czg`
 * (`pnpm commit`), which produces messages in this same format.
 *
 * @see https://www.conventionalcommits.org
 */

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [2, 'always', 200]
  }
}
