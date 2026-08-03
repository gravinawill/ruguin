import { BaseError, StatusError } from '@ruguin/shared-domain'

/*
 * Raised by the composition root, not by an operation. `@ruguin/env` already refuses a `valkey`
 * driver with no master URL at boot, but the factory takes a plain config object and is reachable
 * from a test or a service that never went through the env schema — so the check lives here too,
 * and it is INVALID_INPUT because a misconfigured composition is a caller mistake, not an outage.
 */
export class InvalidCacheConfigError extends BaseError {
  readonly name = 'InvalidCacheConfigError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string; setting: string }) {
    super({ message: `Invalid cache configuration for "${input.setting}": ${input.reason}` })
  }
}
