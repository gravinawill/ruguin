import { Injectable, Logger, type OnApplicationBootstrap, Optional } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { PrismaService } from '../database/prisma/prisma.service'

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
export class OutboxPartitionMaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxPartitionMaintenanceService.name)

  /*
   * `now` has no design:paramtypes token Nest can resolve (a function type reflects to the
   * global `Function`), so @Optional() is required — without it, DI throws on boot instead of
   * falling through to the default.
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly now: () => Date = () => new Date()
  ) {}

  /*
   * Runs once at boot, in addition to the daily cron below: if the app starts in an environment
   * whose existing partitions have already expired (a fresh deploy of an old migration, or the app
   * coming back up after being down for months), every outbox INSERT would fail until midnight —
   * and since enqueue runs inside the use case's own transaction, that takes the business
   * operation down with it, not just the outbox.
   */
  public async onApplicationBootstrap(): Promise<void> {
    /*
     * Never let this abort startup. Maintenance races with itself across app instances — two pods
     * booting together can both see the same stale partition and one loses the drop, and any DDL
     * hiccup would otherwise crashloop the whole service. A process that starts and serves traffic
     * with a stale partition set is strictly better than one that never starts: the daily cron
     * retries, and this log is the alert the design asked for.
     */
    try {
      await this.runMaintenance()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined
      this.logger.error(`Outbox partition maintenance failed at bootstrap: ${message}`, stack)
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  public async runMaintenance(): Promise<void> {
    await this.ensureFuturePartitionsExist()
    await this.dropStalePartitions()
  }

  private async ensureFuturePartitionsExist(): Promise<void> {
    const now = this.now()
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
    const now = this.now()
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
      /*
       * Listing and dropping are two statements, so another instance running the same maintenance
       * — every pod does, and they all boot together on a deploy — can drop a partition in
       * between, making the emptiness check below fail on a relation that no longer exists. That
       * is the desired end state reached by someone else, not an error, and one stale partition
       * must not abort the rest of the sweep either.
       */
      try {
        await this.dropIfEmpty(partitionName)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn(`Could not drop stale outbox partition ${partitionName}: ${message}`)
      }
    }
  }

  private async dropIfEmpty(partitionName: string): Promise<void> {
    const schema = this.prisma.schema
    const [row] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "${schema}"."${partitionName}" WHERE status IN ('PENDING', 'FAILED')`
    )

    /*
     * Every other check in this function fails toward "don't drop" — a missing/unreadable count
     * row must too, instead of falling through to DROP TABLE.
     */
    if (row === undefined || Number(row.count) > 0) {
      this.logger.warn(`Skipping drop of ${partitionName}: it still has non-terminal rows.`)
      return
    }

    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."${partitionName}"`)
    this.logger.log(`Dropped stale outbox partition ${partitionName}.`)
  }
}
