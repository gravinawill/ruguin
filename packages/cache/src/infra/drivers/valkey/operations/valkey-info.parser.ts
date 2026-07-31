import { CacheHealthStatus, type HealthCheckProviderDTO } from '../../../../domain'

export type ValkeyInfo = ReadonlyMap<string, string>

/*
 * Anything at or above this share of `maxmemory` is reported as degraded. It is deliberately
 * below 100: by the time eviction starts the hit rate has already collapsed, and nothing in the
 * error path says so — `evicted_keys` climbing is the only symptom, and it is silent.
 */
const MEMORY_PRESSURE_PERCENTAGE = 90

/*
 * INFO answers `field:value` lines grouped under `# Section` headers, with CRLF endings. Parsed
 * into a flat map because the field names are already unique across the sections we ask for.
 */
export const parseValkeyInfo = (input: { raw: string }): ValkeyInfo => {
  const parsed = new Map<string, string>()

  for (const line of input.raw.split('\n')) {
    const trimmed: string = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    const separatorAt: number = trimmed.indexOf(':')
    if (separatorAt === -1) continue

    parsed.set(trimmed.slice(0, separatorAt), trimmed.slice(separatorAt + 1))
  }

  return parsed
}

export const infoNumber = (input: { fallback: number; field: string; info: ValkeyInfo }): number => {
  const raw: string | undefined = input.info.get(input.field)
  if (raw === undefined) return input.fallback

  const parsed = Number(raw)

  return Number.isFinite(parsed) ? parsed : input.fallback
}

export const infoText = (input: { fallback: string; field: string; info: ValkeyInfo }): string =>
  input.info.get(input.field) ?? input.fallback

export const memoryHealthFrom = (input: { info: ValkeyInfo }): HealthCheckProviderDTO.MemoryHealth => {
  const usedBytes: number = infoNumber({ fallback: 0, field: 'used_memory', info: input.info })
  const configured: number = infoNumber({ fallback: 0, field: 'maxmemory', info: input.info })

  /*
   * `maxmemory:0` means unlimited, not "zero bytes available". A percentage of an unbounded
   * budget has no meaning, so it is null rather than 0 — a 0 would read as "plenty of room" and
   * silence the pressure check on exactly the instances that never trip it.
   */
  const maxBytes: number | null = configured > 0 ? configured : null

  return {
    evictedKeys: infoNumber({ fallback: 0, field: 'evicted_keys', info: input.info }),
    maxBytes,
    usedBytes,
    usedPercentage: maxBytes === null ? null : (usedBytes / maxBytes) * 100
  }
}

export const clientsHealthFrom = (input: { info: ValkeyInfo }): HealthCheckProviderDTO.ClientsHealth => ({
  blocked: infoNumber({ fallback: 0, field: 'blocked_clients', info: input.info }),
  connected: infoNumber({ fallback: 0, field: 'connected_clients', info: input.info }),
  rejectedTotal: infoNumber({ fallback: 0, field: 'rejected_connections', info: input.info })
})

export const serverInfoFrom = (input: { info: ValkeyInfo }): HealthCheckProviderDTO.ServerInfo => ({
  uptimeInSeconds: infoNumber({ fallback: 0, field: 'uptime_in_seconds', info: input.info }),
  version: infoText({ fallback: 'unknown', field: 'redis_version', info: input.info })
})

/*
 * Bytes the replica still has to replay: how far its stream offset trails the master's. Null
 * when either side did not report an offset, because "unknown lag" and "no lag" must not be the
 * same value — a missing field would otherwise read as a perfectly synchronised replica.
 */
export const replicationLagFrom = (input: { master: ValkeyInfo; replica: ValkeyInfo }): number | null => {
  const masterOffset: string | undefined = input.master.get('master_repl_offset')
  const replicaOffset: string | undefined = input.replica.get('slave_repl_offset')
  if (masterOffset === undefined || replicaOffset === undefined) return null

  const ahead = Number(masterOffset)
  const behind = Number(replicaOffset)
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null

  return Math.max(0, ahead - behind)
}

/*
 * "Not healthy" is not an error — it is the answer the caller asked for. Degraded in particular
 * has to stay distinct from unhealthy: pulling an instance out of the load balancer because one
 * replica fell behind turns a degradation into an outage.
 */
export const deriveHealthStatus = (input: {
  masterReachable: boolean
  memory: HealthCheckProviderDTO.MemoryHealth
  replicas: readonly HealthCheckProviderDTO.ReplicaHealth[]
  replicationLagThresholdInBytes: number
}): CacheHealthStatus => {
  if (!input.masterReachable) return CacheHealthStatus.UNHEALTHY

  const isMemoryPressured: boolean =
    input.memory.usedPercentage !== null && input.memory.usedPercentage >= MEMORY_PRESSURE_PERCENTAGE

  const isReplicaDegraded: boolean = input.replicas.some(
    (replica) =>
      !replica.reachable ||
      (replica.replicationLagInBytes !== null && replica.replicationLagInBytes > input.replicationLagThresholdInBytes)
  )

  return isMemoryPressured || isReplicaDegraded ? CacheHealthStatus.DEGRADED : CacheHealthStatus.HEALTHY
}
