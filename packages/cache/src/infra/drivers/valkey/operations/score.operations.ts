import { type Either, failure, success } from '@ruguin/utils'
import { type Redis } from 'iovalkey'

import {
  CacheConsistency,
  type CacheNotInitializedError,
  type CacheOperationError,
  type CountScoresProviderDTO,
  type GetRankProviderDTO,
  type GetScoreProviderDTO,
  type GetTopScoresProviderDTO,
  type IncrementScoreProviderDTO,
  type RemoveScoreProviderDTO,
  type SetScoreProviderDTO
} from '../../../../domain'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { type PhysicalKeyResolver } from '../physical-key.resolver'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

type PipelineReply = Array<[error: Error | null, result: unknown]> | null

type ReadTarget = Readonly<{ connection: Redis; physicalKey: string }>

type ReadTargetOutput = Promise<Either<CacheOperationError, ReadTarget>>

const toNumberOrNull = (input: { value: string | null }): number | null => {
  if (input.value === null) return null

  const parsed = Number(input.value)

  return Number.isFinite(parsed) ? parsed : null
}

/*
 * A per-command error inside a pipeline means the key holds something that is not a sorted set.
 * On a read that is the fail-open answer — "not ranked" — rather than an outage: the caller
 * still gets a usable pair and the loader remains the source of truth.
 */
const pipelineSlot = (input: { index: number; results: PipelineReply }): unknown => {
  const entry: [error: Error | null, result: unknown] | undefined = input.results?.[input.index]
  if (entry === undefined) return null

  const [error, value] = entry

  return error === null ? value : null
}

// ZREVRANGE ... WITHSCORES answers one flat list: member, score, member, score.
const pairsOf = (input: { flat: readonly string[] }): readonly GetTopScoresProviderDTO.Entry[] => {
  const entries: GetTopScoresProviderDTO.Entry[] = []

  for (let index = 0; index + 1 < input.flat.length; index += 2) {
    const member: string | undefined = input.flat[index]
    const score: string | undefined = input.flat[index + 1]
    if (member === undefined || score === undefined) continue

    entries.push({ member, score: toNumberOrNull({ value: score }) ?? 0 })
  }

  return entries
}

export class ScoreOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly keys: PhysicalKeyResolver

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    keys: PhysicalKeyResolver
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.keys = input.keys
  }

  public async setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    const target = await this.writeTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member
    const score: number = input.score

    const added = await this.executor.run({
      command: () => connection.zadd(physicalKey, score, member),
      operation: 'setScore'
    })
    if (added.isFailure()) return failure(added.value)

    const expired = await this.expire({ connection, physicalKey, ttlInMs: input.ttlInMs })
    if (expired !== null) return failure(expired)

    return success({ created: added.value > 0 })
  }

  public async incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    const target = await this.writeTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member
    const by: number = input.by

    const next = await this.executor.run({
      command: () => connection.zincrby(physicalKey, by, member),
      operation: 'incrementScore'
    })
    if (next.isFailure()) return failure(next.value)

    const expired = await this.expire({ connection, physicalKey, ttlInMs: input.ttlInMs })
    if (expired !== null) return failure(expired)

    return success({ score: toNumberOrNull({ value: next.value }) ?? 0 })
  }

  public async getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    const target = await this.readTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member

    const raw = await this.executor.run({
      command: () => connection.zscore(physicalKey, member),
      operation: 'getScore'
    })
    if (raw.isFailure()) return failure(raw.value)

    return success({ score: toNumberOrNull({ value: raw.value }) })
  }

  public async getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    const target = await this.readTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member

    /*
     * Rank and size in one pipeline. A position on its own is rarely what an interface renders —
     * "12th of 340" is — and two separate round trips could straddle a write, reporting a rank
     * against a different total than the one it was computed in.
     */
    const replied = await this.executor.run({
      command: () => connection.pipeline().zrevrank(physicalKey, member).zcard(physicalKey).exec(),
      operation: 'getRank'
    })
    if (replied.isFailure()) return failure(replied.value)

    const rawRank: unknown = pipelineSlot({ index: 0, results: replied.value })
    const rawTotal: unknown = pipelineSlot({ index: 1, results: replied.value })

    // ZREVRANK is zero-based; the contract is one-based, because "0th of 340" reads as an error.
    return success({
      rank: typeof rawRank === 'number' ? rawRank + 1 : null,
      total: typeof rawTotal === 'number' ? rawTotal : 0
    })
  }

  public async getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    const target = await this.readTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const offset: number = input.offset ?? 0
    const stop: number = offset + input.limit - 1

    const flat = await this.executor.run({
      command: () => connection.zrevrange(physicalKey, offset, stop, 'WITHSCORES'),
      operation: 'getTopScores'
    })
    if (flat.isFailure()) return failure(flat.value)

    return success({ entries: pairsOf({ flat: flat.value }) })
  }

  public async removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    const target = await this.writeTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member

    const removed = await this.executor.run({
      command: () => connection.zrem(physicalKey, member),
      operation: 'removeScore'
    })
    if (removed.isFailure()) return failure(removed.value)

    return success({ removed: removed.value > 0 })
  }

  public async countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    const target = await this.readTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value

    const total = await this.executor.run({
      command: () => connection.zcard(physicalKey),
      operation: 'countScores'
    })
    if (total.isFailure()) return failure(total.value)

    return success({ total: total.value })
  }

  private async expire(input: {
    connection: Redis
    physicalKey: string
    ttlInMs: number | undefined
  }): Promise<CacheOperationError | null> {
    const ttlInMs: number | undefined = input.ttlInMs
    if (ttlInMs === undefined) return null

    const connection: Redis = input.connection
    const physicalKey: string = input.physicalKey

    // Sorted sets have no per-member TTL, so the expiry covers the whole set (spec §5.5).
    const expired = await this.executor.run({
      command: () => connection.pexpire(physicalKey, ttlInMs),
      operation: 'expireScores'
    })

    return expired.isFailure() ? expired.value : null
  }

  private async writeTarget(input: { key: string; namespace: string }): ReadTargetOutput {
    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    return success({ connection: master.value, physicalKey: key.value })
  }

  /*
   * The consistency cascade picks both the node the version comes from and the node the command
   * runs on. Splitting them would let a strong read resolve a fresh version on the master and
   * then look it up on a replica that has not received the write yet — the stale answer the mode
   * is bought to rule out.
   */
  private async readTarget(input: {
    consistency?: CacheConsistency
    key: string
    namespace: string
  }): ReadTargetOutput {
    const consistency: CacheConsistency = this.keys.consistencyFor(input)
    const client: Either<CacheNotInitializedError, Redis> =
      consistency === CacheConsistency.STRONG ? this.connections.master() : this.connections.reader()
    if (client.isFailure()) return failure(client.value)

    const key = await this.keys.physicalKey({ ...input, consistency })
    if (key.isFailure()) return failure(key.value)

    return success({ connection: client.value, physicalKey: key.value })
  }
}
