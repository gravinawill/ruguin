import { type OnCacheError } from '../../../../application/on-cache-error.ts'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager.ts'
import { type ValkeyCommandExecutor } from '../valkey-command.executor.ts'

export type InvalidationMessage = Readonly<{ namespace: string; version: number }>

export const invalidationChannelOf = (input: { prefix: string }): string => `${input.prefix}:__invalidation__`

export const encodeInvalidation = (input: InvalidationMessage): string => JSON.stringify(input)

/*
 * Anything can land on a Pub/Sub channel — another service, an operator with valkey-cli, an
 * older build of this package. A malformed payload has to be droppable without touching the
 * memo, so the decoder answers null instead of throwing or half-applying.
 */
export const decodeInvalidation = (input: { raw: string }): InvalidationMessage | null => {
  let parsed: unknown

  try {
    parsed = JSON.parse(input.raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null

  const candidate: Partial<Record<keyof InvalidationMessage, unknown>> = parsed

  if (typeof candidate.namespace !== 'string' || candidate.namespace.length === 0) return null
  if (typeof candidate.version !== 'number' || !Number.isSafeInteger(candidate.version)) return null

  return { namespace: candidate.namespace, version: candidate.version }
}

/*
 * Fire-and-forget by design (spec §4.3): the INCR that precedes it is what actually invalidates
 * the namespace, and the memo TTL is what bounds the window if this message never lands. A
 * publish that failed therefore reports and returns — turning it into a failure of
 * `invalidateNamespace` would make an already-successful invalidation look like it did not
 * happen, and callers would retry an INCR that does not need retrying.
 */
export class InvalidationPublisher {
  private readonly channel: string
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly onCacheError: OnCacheError

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    onCacheError: OnCacheError
    prefix: string
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.onCacheError = input.onCacheError
    this.channel = invalidationChannelOf({ prefix: input.prefix })
  }

  public async publish(input: InvalidationMessage): Promise<void> {
    const master = this.connections.master()
    if (master.isFailure()) {
      this.report({ error: master.value, namespace: input.namespace })
      return
    }

    const client = master.value
    const payload: string = encodeInvalidation(input)

    const published = await this.executor.run({
      command: () => client.publish(this.channel, payload),
      operation: 'publishInvalidation'
    })

    if (published.isFailure()) this.report({ error: published.value, namespace: input.namespace })
  }

  private report(input: { error: unknown; namespace: string }): void {
    this.onCacheError({
      error: input.error,
      key: this.channel,
      namespace: input.namespace,
      operation: 'publishInvalidation'
    })
  }
}
