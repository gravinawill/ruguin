import { type Either } from '@ruguin/utils'

import { type CacheDriver, type CacheHealthStatus } from '../../enums/index.ts'
import { type CacheNotInitializedError } from '../../errors/index.ts'

export namespace HealthCheckProviderDTO {
  export type NodeHealth = Readonly<{
    reachable: boolean
    latencyInMs: number
    role: string
    error?: string
  }>

  export type ReplicaHealth = Readonly<{
    host: string
    reachable: boolean
    latencyInMs: number
    replicationLagInBytes: number | null
    error?: string
  }>

  export type MemoryHealth = Readonly<{
    usedBytes: number
    maxBytes: number | null
    usedPercentage: number | null
    evictedKeys: number
  }>

  export type ClientsHealth = Readonly<{
    connected: number
    blocked: number
    rejectedTotal: number
  }>

  export type ServerInfo = Readonly<{
    version: string
    uptimeInSeconds: number
  }>

  export type Input = Readonly<{ includeReplicas?: boolean; timeoutInMs?: number }>

  export type OutputError = Readonly<CacheNotInitializedError>
  export type OutputSuccess = Readonly<{
    status: CacheHealthStatus
    driver: CacheDriver
    checkedAt: Date
    master: NodeHealth
    replicas: readonly ReplicaHealth[]
    memory: MemoryHealth
    clients: ClientsHealth
    server: ServerInfo
  }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IHealthCheckProvider {
  healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output
}
