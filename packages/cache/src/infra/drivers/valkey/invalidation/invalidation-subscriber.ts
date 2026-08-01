import { type Either, failure, success } from '@ruguin/utils'
import { type Redis } from 'iovalkey'

import { type OnCacheError } from '../../../../application/on-cache-error.ts'
import {
  type CacheConnectionError,
  type CacheNotInitializedError,
  type CacheTimeoutError
} from '../../../../domain/index.ts'
import { type NamespaceVersionResolver } from '../../../namespace-version.resolver.ts'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager.ts'
import { type ValkeyCommandExecutor } from '../valkey-command.executor.ts'

import { decodeInvalidation, invalidationChannelOf, type InvalidationMessage } from './invalidation-publisher.ts'

type StartOutput = Promise<Either<CacheConnectionError | CacheNotInitializedError | CacheTimeoutError, true>>

export class InvalidationSubscriber {
  private readonly channel: string
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly onCacheError: OnCacheError
  private readonly versions: NamespaceVersionResolver

  private started = false

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    onCacheError: OnCacheError
    prefix: string
    versions: NamespaceVersionResolver
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.onCacheError = input.onCacheError
    this.versions = input.versions
    this.channel = invalidationChannelOf({ prefix: input.prefix })
  }

  public async start(): StartOutput {
    if (this.started) return success(true)

    const subscriber = this.connections.subscriber()
    if (subscriber.isFailure()) return failure(subscriber.value)

    const client: Redis = subscriber.value

    client.on('message', (channel: string, raw: string) => {
      this.apply({ channel, raw })
    })

    /*
     * Every `ready` drops the memo whole, not just the namespace the last message named. A
     * reconnect means messages may have been missed while the socket was down and there is no
     * record of which namespaces they carried, so the only safe assumption is that every
     * memoised version is suspect. The first `ready` fires against an empty memo, so this costs
     * nothing at startup.
     *
     * Re-subscribing is not done here: iovalkey replays the subscription itself on reconnect
     * (`autoResubscribe`, on by default), and issuing a second SUBSCRIBE would race that replay.
     */
    client.on('ready', () => {
      this.versions.clearMemo()
    })

    const channel: string = this.channel

    const subscribed = await this.executor.run({
      command: () => client.subscribe(channel),
      operation: 'subscribeInvalidation'
    })
    if (subscribed.isFailure()) return failure(subscribed.value)

    this.started = true

    return success(true)
  }

  private apply(input: { channel: string; raw: string }): void {
    if (input.channel !== this.channel) return

    const message: InvalidationMessage | null = decodeInvalidation({ raw: input.raw })

    if (message === null) {
      this.onCacheError({
        error: new Error(`unparseable invalidation payload: ${input.raw}`),
        key: input.channel,
        namespace: '',
        operation: 'applyInvalidation'
      })

      return
    }

    /*
     * Our own publish comes back to us as well. `applyBroadcast` only ever moves a version
     * forward, so re-applying the number we just wrote is a no-op — and the same guard is what
     * keeps a redelivered or out-of-order message from walking the memo backwards.
     */
    this.versions.applyBroadcast(message)
  }
}
