import { Inject, Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'

import { OutboxStatus, type Prisma } from '../../generated/prisma/client'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '../contracts/message-producer.port'
import { PrismaService } from '../database/prisma.service'

const RELAY_INTERVAL_MS = 1000
const BATCH_SIZE = 20
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 1000

type EligibleRow = {
  id: string
  createdAt: Date
  eventId: string
  module: string
  topic: string
  key: string
  name: string
  payload: Prisma.JsonValue
  attempts: number
}

function computeNextAttemptAt(attempts: number): Date {
  return new Date(Date.now() + BASE_BACKOFF_MS * 2 ** attempts)
}

@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly messageProducer: MessageProducerPort
  ) {}

  @Interval(RELAY_INTERVAL_MS)
  public async relay(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      /*
       * FOR UPDATE cannot combine with a window function at the same query level, so `ranked`
       * computes eligibility unlocked and the outer SELECT re-joins by primary key to lock only
       * the winning row of each (module, key) pair. Two relay instances racing on the same tick
       * never publish out of order: only one row per key is ever eligible, and SKIP LOCKED makes
       * the loser skip it entirely rather than pick a different one.
       *
       * Raw SQL doesn't inherit the PrismaPg adapter's `schema` option the way `prisma.<model>.*`
       * calls do, so the table needs the `core_server` schema spelled out explicitly.
       */
      const rows = await tx.$queryRaw<EligibleRow[]>`
        WITH ranked AS (
          SELECT id, "createdAt",
                 ROW_NUMBER() OVER (PARTITION BY module, key ORDER BY "createdAt") AS rn
          FROM core_server.outbox_messages
          WHERE status = 'PENDING'
            AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
        )
        SELECT o.id, o."createdAt", o."eventId", o.module, o.topic, o.key, o.name, o.payload, o.attempts
        FROM core_server.outbox_messages o
        JOIN ranked r ON r.id = o.id AND r."createdAt" = o."createdAt"
        WHERE r.rn = 1
        ORDER BY o."createdAt"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE OF o SKIP LOCKED
      `

      for (const row of rows) {
        await this.processRow(tx, row)
      }
    })
  }

  private async processRow(tx: Prisma.TransactionClient, row: EligibleRow): Promise<void> {
    const published = await this.messageProducer.publish({
      key: row.key,
      message: { eventId: row.eventId, name: row.name, payload: row.payload },
      topic: row.topic
    })

    if (published.isSuccess()) {
      await tx.outboxMessage.update({
        data: { publishedAt: new Date(), status: OutboxStatus.PUBLISHED },
        where: { id_createdAt: { createdAt: row.createdAt, id: row.id } }
      })
      return
    }

    const attempts = row.attempts + 1

    if (attempts >= MAX_ATTEMPTS) {
      await tx.outboxMessage.update({
        data: { attempts, lastError: published.value.message, status: OutboxStatus.FAILED },
        where: { id_createdAt: { createdAt: row.createdAt, id: row.id } }
      })
      this.logger.error(`Outbox message ${row.id} moved to FAILED after ${attempts} attempts.`)
      return
    }

    await tx.outboxMessage.update({
      data: { attempts, lastError: published.value.message, nextAttemptAt: computeNextAttemptAt(attempts) },
      where: { id_createdAt: { createdAt: row.createdAt, id: row.id } }
    })
  }
}
