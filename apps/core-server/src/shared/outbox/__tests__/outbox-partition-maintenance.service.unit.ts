import { describe, expect, it } from 'vitest'

import { type PrismaService } from '../../database/prisma.service'
import { OutboxPartitionMaintenanceService } from '../outbox-partition-maintenance.service'

function createPrismaStub(input: { stalePartitions?: string[]; nonTerminalCounts?: Record<string, number> } = {}): {
  prisma: PrismaService
  executed: string[]
  queryRawValues: unknown[][]
} {
  const executed: string[] = []
  const queryRawValues: unknown[][] = []
  const stalePartitions = input.stalePartitions ?? []
  const nonTerminalCounts = input.nonTerminalCounts ?? {}

  const prisma = {
    // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async $executeRawUnsafe contract; stub has nothing to await
    $executeRawUnsafe: async (sql: string) => {
      executed.push(sql)
      return 0
    },
    /*
     * Captures the tagged template's interpolated values (schema, cutoffName), not just the
     * static SQL text, so a test can assert what dropStalePartitions actually computed.
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async $queryRaw contract; stub has nothing to await
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queryRawValues.push(values)
      return stalePartitions.map((partitionName) => ({ partitionName }))
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async $queryRawUnsafe contract; stub has nothing to await
    $queryRawUnsafe: async (sql: string) => {
      const match = /FROM "[^"]+"\."([^"]+)"/.exec(sql)
      const partitionName = match?.[1] ?? ''
      return [{ count: BigInt(nonTerminalCounts[partitionName] ?? 0) }]
    },
    schema: 'core_server'
  } as unknown as PrismaService

  return { executed, prisma, queryRawValues }
}

describe('OutboxPartitionMaintenanceService#runMaintenance', () => {
  it('creates the current month plus the two following, each with IF NOT EXISTS', async () => {
    const { prisma, executed } = createPrismaStub()
    const service = new OutboxPartitionMaintenanceService(prisma)

    await service.runMaintenance()

    const creates = executed.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS'))
    expect(creates).toHaveLength(3)
    for (const sql of creates) expect(sql).toContain('PARTITION OF "core_server"."outbox_messages"')
  })

  it('drops a stale partition that has no PENDING or FAILED rows left', async () => {
    const { prisma, executed } = createPrismaStub({
      nonTerminalCounts: { outbox_messages_2026_01: 0 },
      stalePartitions: ['outbox_messages_2026_01']
    })
    const service = new OutboxPartitionMaintenanceService(prisma)

    await service.runMaintenance()

    expect(executed).toContain('DROP TABLE IF EXISTS "core_server"."outbox_messages_2026_01"')
  })

  it('keeps a stale partition that still has non-terminal rows', async () => {
    const { prisma, executed } = createPrismaStub({
      nonTerminalCounts: { outbox_messages_2026_01: 2 },
      stalePartitions: ['outbox_messages_2026_01']
    })
    const service = new OutboxPartitionMaintenanceService(prisma)

    await service.runMaintenance()

    expect(executed.some((sql) => sql.startsWith('DROP TABLE'))).toBe(false)
  })

  it('rolls the year over when creating future partitions from December', async () => {
    const { prisma, executed } = createPrismaStub()
    const service = new OutboxPartitionMaintenanceService(prisma, () => new Date(Date.UTC(2026, 11, 15)))

    await service.runMaintenance()

    const creates = executed.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS'))
    expect(creates.map((sql) => /"([^"]+)" PARTITION OF/.exec(sql)?.[1])).toEqual([
      'outbox_messages_2026_12',
      'outbox_messages_2027_01',
      'outbox_messages_2027_02'
    ])
  })

  it('rolls the year over when computing the retention cutoff from January', async () => {
    const { prisma, queryRawValues } = createPrismaStub()
    const service = new OutboxPartitionMaintenanceService(prisma, () => new Date(Date.UTC(2026, 0, 15)))

    await service.runMaintenance()

    /*
     * RETENTION_MONTHS=3 back from January 2026 is October 2025 — the query's own [schema,
     * cutoffName] bind values are what dropStalePartitions actually computed, not fixture data.
     */
    expect(queryRawValues[0]).toEqual(['core_server', 'outbox_messages_2025_10'])
  })
})
