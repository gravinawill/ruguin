import { describe, expect, it } from 'vitest'

import { type PrismaService } from '../../database/prisma.service'
import { OutboxPartitionMaintenanceService } from '../outbox-partition-maintenance.service'

function createPrismaStub(input: { stalePartitions?: string[]; nonTerminalCounts?: Record<string, number> } = {}): {
  prisma: PrismaService
  executed: string[]
} {
  const executed: string[] = []
  const stalePartitions = input.stalePartitions ?? []
  const nonTerminalCounts = input.nonTerminalCounts ?? {}

  const prisma = {
    // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async $executeRawUnsafe contract; stub has nothing to await
    $executeRawUnsafe: async (sql: string) => {
      executed.push(sql)
      return 0
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async $queryRaw contract; stub has nothing to await
    $queryRaw: async () => stalePartitions.map((partitionName) => ({ partitionName })),
    // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async $queryRawUnsafe contract; stub has nothing to await
    $queryRawUnsafe: async (sql: string) => {
      const match = /FROM "[^"]+"\."([^"]+)"/.exec(sql)
      const partitionName = match?.[1] ?? ''
      return [{ count: BigInt(nonTerminalCounts[partitionName] ?? 0) }]
    },
    schema: 'core_server'
  } as unknown as PrismaService

  return { executed, prisma }
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
})
