/*
 * The out-of-band channel for cache failures the orchestrators deliberately swallow.
 *
 * It carries the call it came from, not just the error: a bare `unknown` forces whoever logs it
 * to reach for `instanceof` plus message parsing to tell a failed release from a failed read,
 * and leaves the report with no way back to the key that produced it. Both orchestrators report
 * through this one shape so a single handler can serve them.
 */
export type OnCacheError = (
  input: Readonly<{ operation: string; namespace: string; key: string; error: unknown }>
) => void
