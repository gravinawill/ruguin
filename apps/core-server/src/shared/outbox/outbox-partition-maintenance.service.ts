import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { PrismaService } from '../database/prisma.service'

const MONTHS_AHEAD = 2
const RETENTION_MONTHS = 3

function partitionNameFor(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `outbox_messages_${year}_${month}`
}

function monthBoundsFor(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
  return { end, start }
}

function toSqlDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

@Injectable()
export class OutboxPartitionMaintenanceService {
  private readonly logger = new Logger(OutboxPartitionMaintenanceService.name)

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  public async runMaintenance(): Promise<void> {
    await this.ensureFuturePartitionsExist()
    await this.dropStalePartitions()
  }

  private async ensureFuturePartitionsExist(): Promise<void> {
    const now = new Date()
    const schema = this.prisma.schema

    for (let offset = 0; offset <= MONTHS_AHEAD; offset += 1) {
      const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
      const partitionName = partitionNameFor(target)
      const { start, end } = monthBoundsFor(target)

      /*
       * Table/partition identifiers can't be bound as query parameters — CREATE TABLE ... PARTITION
       * OF needs the name inlined. Safe here: partitionName/schema come from Date arithmetic and
       * DATABASE_URL, never external input. Both the parent table and the new partition need the
       * schema spelled out — raw SQL doesn't inherit PrismaPg's schema option the way
       * prisma.<model>.* calls do.
       */
      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${schema}"."${partitionName}" PARTITION OF "${schema}"."outbox_messages" FOR VALUES FROM ('${toSqlDate(start)}') TO ('${toSqlDate(end)}')`
      )

      this.logger.log(`Ensured outbox partition ${partitionName} exists.`)
    }
  }

  private async dropStalePartitions(): Promise<void> {
    const now = new Date()
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETENTION_MONTHS, 1))
    /*
     * Partition names are zero-padded `outbox_messages_YYYY_MM`, so lexicographic and chronological
     * order coincide — a plain string comparison is enough to find stale ones.
     */
    const cutoffName = partitionNameFor(cutoff)
    const schema = this.prisma.schema

    const partitions = await this.prisma.$queryRaw<Array<{ partitionName: string }>>`
      SELECT child.relname AS "partitionName"
      FROM pg_inherits
      JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
      JOIN pg_class child ON pg_inherits.inhrelid = child.oid
      JOIN pg_namespace ns ON parent.relnamespace = ns.oid
      WHERE parent.relname = 'outbox_messages'
        AND ns.nspname = ${schema}
        AND child.relname < ${cutoffName}
    `

    for (const { partitionName } of partitions) {
      await this.dropIfEmpty(partitionName)
    }
  }

  private async dropIfEmpty(partitionName: string): Promise<void> {
    const schema = this.prisma.schema
    const [row] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "${schema}"."${partitionName}" WHERE status IN ('PENDING', 'FAILED')`
    )

    if (row !== undefined && Number(row.count) > 0) {
      this.logger.warn(`Skipping drop of ${partitionName}: it still has non-terminal rows.`)
      return
    }

    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."${partitionName}"`)
    this.logger.log(`Dropped stale outbox partition ${partitionName}.`)
  }
}
