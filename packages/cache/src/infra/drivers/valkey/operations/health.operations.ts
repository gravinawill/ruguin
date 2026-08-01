import { failure, success } from '@ruguin/utils'
import { type Redis } from 'iovalkey'

import { CacheDriver, type HealthCheckProviderDTO } from '../../../../domain/index.ts'
import { type ValkeyConnectionManager, type ValkeyReplica } from '../connection/valkey-connection.manager.ts'
import { type ValkeyCommandExecutor } from '../valkey-command.executor.ts'

import {
  clientsHealthFrom,
  deriveHealthStatus,
  infoText,
  memoryHealthFrom,
  parseValkeyInfo,
  replicationLagFrom,
  serverInfoFrom,
  type ValkeyInfo
} from './valkey-info.parser.ts'

/*
 * `stats` carries `evicted_keys` and `rejected_connections`, which are the two signals that
 * announce trouble before anything starts erroring: eviction quietly destroys the hit rate, and
 * a rejected connection surfaces as an intermittent timeout that then disappears.
 */
const INFO_SECTIONS: readonly string[] = ['replication', 'memory', 'clients', 'server', 'stats']

type Probe = Readonly<{ error?: string; info: ValkeyInfo; latencyInMs: number; reachable: boolean }>

export class HealthOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly replicationLagThresholdInBytes: number

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    replicationLagThresholdInBytes: number
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.replicationLagThresholdInBytes = input.replicationLagThresholdInBytes
  }

  public async check(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    /*
     * The only failure this contract admits. An unreachable master is a *reported* status, not
     * an Either failure — the caller asked how the cache is doing and "it is down" answers that.
     * Calling before connect() is a programming error, and that is what fails.
     */
    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const timeoutInMs: number | undefined = input?.timeoutInMs
    const probe: Probe = await this.probe({ client: master.value, timeoutInMs })

    const replicas: readonly HealthCheckProviderDTO.ReplicaHealth[] =
      input?.includeReplicas === false ? [] : await this.probeReplicas({ master: probe.info, timeoutInMs })

    const memory: HealthCheckProviderDTO.MemoryHealth = memoryHealthFrom({ info: probe.info })

    return success({
      checkedAt: new Date(),
      clients: clientsHealthFrom({ info: probe.info }),
      driver: CacheDriver.VALKEY,
      master: {
        latencyInMs: probe.latencyInMs,
        reachable: probe.reachable,
        role: infoText({ fallback: 'unknown', field: 'role', info: probe.info }),
        ...(probe.error !== undefined && { error: probe.error })
      },
      memory,
      replicas,
      server: serverInfoFrom({ info: probe.info }),
      status: deriveHealthStatus({
        masterReachable: probe.reachable,
        memory,
        replicas,
        replicationLagThresholdInBytes: this.replicationLagThresholdInBytes
      })
    })
  }

  private async probeReplicas(input: {
    master: ValkeyInfo
    timeoutInMs: number | undefined
  }): Promise<readonly HealthCheckProviderDTO.ReplicaHealth[]> {
    const replicas: readonly ValkeyReplica[] = this.connections.replicas()

    return Promise.all(
      replicas.map(async (replica): Promise<HealthCheckProviderDTO.ReplicaHealth> => {
        const probe: Probe = await this.probe({ client: replica.client, timeoutInMs: input.timeoutInMs })

        return {
          host: replica.host,
          latencyInMs: probe.latencyInMs,
          reachable: probe.reachable,
          replicationLagInBytes: probe.reachable
            ? replicationLagFrom({ master: input.master, replica: probe.info })
            : null,
          ...(probe.error !== undefined && { error: probe.error })
        }
      })
    )
  }

  private async probe(input: { client: Redis; timeoutInMs: number | undefined }): Promise<Probe> {
    const client: Redis = input.client
    const budget: { timeoutInMs?: number } = input.timeoutInMs === undefined ? {} : { timeoutInMs: input.timeoutInMs }

    const startedAt: number = Date.now()

    const pong = await this.executor.run({ command: () => client.ping(), operation: 'healthCheck', ...budget })

    const latencyInMs: number = Date.now() - startedAt

    if (pong.isFailure()) {
      return { error: pong.value.message, info: new Map<string, string>(), latencyInMs, reachable: false }
    }

    const raw = await this.executor.run({
      command: () => client.info(...INFO_SECTIONS),
      operation: 'healthCheck',
      ...budget
    })

    /*
     * PING answered but INFO did not: the node is up, we just have no numbers for it. Reported
     * as reachable with an empty map so the status stays healthy on the strength of the PING,
     * while the missing detail is visible in `error`.
     */
    if (raw.isFailure()) {
      return { error: raw.value.message, info: new Map<string, string>(), latencyInMs, reachable: true }
    }

    return { info: parseValkeyInfo({ raw: raw.value }), latencyInMs, reachable: true }
  }
}
