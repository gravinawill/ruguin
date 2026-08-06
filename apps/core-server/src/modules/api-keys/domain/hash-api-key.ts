import { createHash } from 'node:crypto'

/*
 * SHA-256, not bcrypt: the input is already a high-entropy, randomly generated token (see
 * prisma/seed.ts), not a human-chosen password. Brute-forcing the key space is infeasible
 * regardless of hash speed, so a slow KDF would only add latency to every authenticated request
 * without a matching security gain.
 */
export function hashApiKey(input: { rawKey: string }): string {
  return createHash('sha256').update(input.rawKey).digest('hex')
}
