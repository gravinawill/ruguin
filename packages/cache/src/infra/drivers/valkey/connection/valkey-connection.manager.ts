import { type Either, failure, success } from '@ruguin/utils'
import { Redis, type RedisOptions } from 'iovalkey'

import { CacheConnectionError, CacheNotInitializedError } from '../../../../domain'

export type ValkeyReplica = Readonly<{ client: Redis; host: string }>

type ClientOutput = Either<CacheNotInitializedError, Redis>

/*
 * Both defaults fight fail-open and both are turned off deliberately.
 *
 * `enableOfflineQueue` parks commands issued while the socket is down and replays them on
 * reconnect, so a caller waits for the outage to end instead of missing fast and going to the
 * source. `maxRetriesPerRequest` at its default of 20 turns one dead command into twenty round
 * trips before anyone hears about it. Cache is an optimisation: it has to fail quickly enough
 * for the breaker to notice and for the loader to take over.
 */
const BASE_OPTIONS: RedisOptions = {
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1
}

const hostOf = (input: { url: string }): string => {
  try {
    return new URL(input.url).host
  } catch {
    // Only used to label the node in the health payload; an unparseable URL is not fatal here.
    return input.url
  }
}

/*
 * Round-robin over the replicas that are actually ready, starting at the cursor. Returning null
 * rather than an unready client is what makes the fallback to the master a routing decision
 * instead of a command that fails and then has to be retried somewhere else.
 */
export const pickReadyReplica = <T extends { client: { status: string } }>(input: {
  cursor: number
  replicas: readonly T[]
}): T | null => {
  const total: number = input.replicas.length
  if (total === 0) return null

  for (let offset = 0; offset < total; offset += 1) {
    const candidate: T | undefined = input.replicas[(input.cursor + offset) % total]
    if (candidate?.client.status === 'ready') return candidate
  }

  return null
}

export class ValkeyConnectionManager {
  private readonly masterUrl: string
  private readonly options: RedisOptions
  private readonly replicaUrls: readonly string[]
  private readonly withSubscriber: boolean

  private cursor = 0
  private masterClient: Redis | null = null
  private replicaClients: readonly ValkeyReplica[] = []
  private subscriberClient: Redis | null = null

  constructor(input: {
    masterUrl: string
    options?: RedisOptions
    replicaUrls?: readonly string[]
    withSubscriber: boolean
  }) {
    this.masterUrl = input.masterUrl
    this.replicaUrls = input.replicaUrls ?? []
    this.withSubscriber = input.withSubscriber
    this.options = { ...BASE_OPTIONS, ...input.options }
  }

  public async connect(): Promise<Either<CacheConnectionError, true>> {
    if (this.masterClient !== null) return success(true)

    const master: Redis = new Redis(this.masterUrl, this.options)
    const replicas: readonly ValkeyReplica[] = this.replicaUrls.map((url) => ({
      client: new Redis(url, this.options),
      host: hostOf({ url })
    }))

    /*
     * A third connection, and not an optimisation: a client in subscribe mode refuses ordinary
     * commands, so the invalidation channel cannot share the master's socket.
     */
    const subscriber: Redis | null = this.withSubscriber ? new Redis(this.masterUrl, this.options) : null

    try {
      await master.connect()
      if (subscriber !== null) await subscriber.connect()
    } catch (error: unknown) {
      await ValkeyConnectionManager.dispose({ clients: [master, ...replicas.map((r) => r.client), subscriber] })

      return failure(new CacheConnectionError({ operation: 'connect', error }))
    }

    /*
     * A replica that refuses to come up is a degradation, not an outage: reads fall back to the
     * master and healthCheck reports it as degraded. Only the master is fatal.
     */
    await Promise.all(
      replicas.map(async (replica): Promise<void> => {
        try {
          await replica.client.connect()
        } catch {
          // Swallowed on purpose — see above.
        }
      })
    )

    this.masterClient = master
    this.replicaClients = replicas
    this.subscriberClient = subscriber

    return success(true)
  }

  public async disconnect(): Promise<Either<CacheConnectionError, true>> {
    const clients: ReadonlyArray<Redis | null> = [
      this.masterClient,
      ...this.replicaClients.map((replica) => replica.client),
      this.subscriberClient
    ]

    this.masterClient = null
    this.replicaClients = []
    this.subscriberClient = null
    this.cursor = 0

    await ValkeyConnectionManager.dispose({ clients })

    return success(true)
  }

  public isConnected(): boolean {
    return this.masterClient !== null
  }

  public master(): ClientOutput {
    if (this.masterClient === null) return failure(new CacheNotInitializedError({ operation: 'master' }))

    return success(this.masterClient)
  }

  /*
   * Reads in eventual mode land here. Strong reads ask for `master()` by name instead, because
   * "fresh" that comes off a replica which has not seen the INCR yet is not fresh at all.
   */
  public reader(): ClientOutput {
    if (this.masterClient === null) return failure(new CacheNotInitializedError({ operation: 'reader' }))

    const picked: ValkeyReplica | null = pickReadyReplica({ cursor: this.cursor, replicas: this.replicaClients })
    this.cursor = this.replicaClients.length === 0 ? 0 : (this.cursor + 1) % this.replicaClients.length

    return success(picked?.client ?? this.masterClient)
  }

  public replicas(): readonly ValkeyReplica[] {
    return this.replicaClients
  }

  public subscriber(): ClientOutput {
    if (this.subscriberClient === null) return failure(new CacheNotInitializedError({ operation: 'subscriber' }))

    return success(this.subscriberClient)
  }

  private static async dispose(input: { clients: ReadonlyArray<Redis | null> }): Promise<void> {
    await Promise.all(
      input.clients.map(async (client): Promise<void> => {
        if (client === null || client.status === 'end') return

        try {
          await client.quit()
        } catch {
          /*
           * Teardown is not actionable: a socket that will not close politely is closed rudely.
           * Surfacing this would make shutdown fail for a connection nobody will use again.
           */
          client.disconnect()
        }
      })
    )
  }
}
