import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type PrismaService } from '../../database/prisma/prisma.service'
import { OutboxPartitionMaintenanceService } from '../outbox-partition-maintenance.service'

import { createTestPrismaService } from './outbox-test-context'

const context: { prisma: PrismaService | null } = { prisma: null }

const prisma = (): PrismaService => {
  if (context.prisma === null) throw new Error('prisma was never connected')
  return context.prisma
}

beforeAll(() => {
  context.prisma = createTestPrismaService()
})

afterAll(async () => {
  await prisma().$disconnect()
})

describe('OutboxPartitionMaintenanceService against a live Postgres', () => {
  it('creates future partitions that accept an insert, and is idempotent on rerun', async () => {
    const service = new OutboxPartitionMaintenanceService(prisma())

    await service.runMaintenance()
    await service.runMaintenance() // rerun must not throw (IF NOT EXISTS)

    const created = await prisma().outboxMessage.create({
      data: {
        eventId: `partition-check-${Date.now()}`,
        key: 'partition-check',
        module: 'outbox-partition-maintenance-int-test',
        name: 'test.partition-check',
        payload: {},
        topic: 'test-topic'
      }
    })

    try {
      expect(created.id).toBeDefined()
    } finally {
      await prisma().outboxMessage.delete({ where: { id_createdAt: { createdAt: created.createdAt, id: created.id } } })
    }
  })

  it('drops an old, empty partition but keeps one that still has PENDING rows', async () => {
    const schema = prisma().schema
    const dropCandidate = 'outbox_messages_2020_01'
    const keepCandidate = 'outbox_messages_2020_02'

    await prisma().$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${schema}"."${dropCandidate}" PARTITION OF "${schema}"."outbox_messages" FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`
    )
    await prisma().$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${schema}"."${keepCandidate}" PARTITION OF "${schema}"."outbox_messages" FOR VALUES FROM ('2020-02-01') TO ('2020-03-01')`
    )
    await prisma().$executeRawUnsafe(
      `INSERT INTO "${schema}"."${keepCandidate}" (id, "eventId", module, topic, key, name, payload, status, attempts, "createdAt")
       VALUES ('kept-row', 'kept-event', 'retention-int-test', 't', 'k', 'n', '{}', 'PENDING', 0, '2020-02-15')`
    )

    const service = new OutboxPartitionMaintenanceService(prisma())

    try {
      await service.runMaintenance()

      const remaining = await prisma().$queryRaw<Array<{ relname: string }>>`
        SELECT child.relname
        FROM pg_inherits
        JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
        JOIN pg_class child ON pg_inherits.inhrelid = child.oid
        JOIN pg_namespace ns ON parent.relnamespace = ns.oid
        WHERE parent.relname = 'outbox_messages'
          AND ns.nspname = ${schema}
      `
      const names = remaining.map((row) => row.relname)

      expect(names).not.toContain(dropCandidate)
      expect(names).toContain(keepCandidate)
    } finally {
      await prisma().$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."${keepCandidate}"`)
    }
  })
})
