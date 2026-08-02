import { Inject, Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'

import { OutboxStatus, Prisma } from '../../generated/prisma/client'
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
    try {
      await this.prisma.$transaction(async (tx) => {
        const table = Prisma.raw(`"${this.prisma.schema}"."outbox_messages"`)

        /*
         * The due-ness check (nextAttemptAt) must apply AFTER ranking, not inside the ranked CTE's
         * WHERE — filtering it there would drop a row still in backoff out of its partition
         * entirely, letting ROW_NUMBER() re-rank around it and publish a later message of the same
         * key first. Ranking over every PENDING row (backoff or not) and checking due-ness only on
         * the winner gives real head-of-line blocking: a key whose oldest message is in backoff
         * yields nothing until that message is due again.
         *
         * The table is interpolated via Prisma.raw() because raw SQL doesn't inherit the PrismaPg
         * adapter's `schema` option the way `prisma.<model>.*` calls do — it needs the schema
         * identifier spelled out explicitly, derived the same way PrismaService derives it.
         */
        const rows = await tx.$queryRaw<EligibleRow[]>`
          WITH ranked AS (
            SELECT id, "createdAt", "nextAttemptAt",
                   ROW_NUMBER() OVER (PARTITION BY module, key ORDER BY "createdAt") AS rn
            FROM ${table}
            WHERE status = 'PENDING'
          )
          SELECT o.id, o."createdAt", o."eventId", o.module, o.topic, o.key, o.name, o.payload, o.attempts
          FROM ${table} o
          JOIN ranked r ON r.id = o.id AND r."createdAt" = o."createdAt"
          WHERE r.rn = 1
            AND (r."nextAttemptAt" IS NULL OR r."nextAttemptAt" <= now())
          ORDER BY o."createdAt"
          LIMIT ${BATCH_SIZE}
          FOR UPDATE OF o SKIP LOCKED
        `

        for (const row of rows) {
          await this.processRow(tx, row)
        }
      })
    } catch (error: unknown) {
      this.logger.error(`Outbox relay tick failed: ${error instanceof Error ? error.message : String(error)}`)
    }
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
      /*
       * A FAILED message does not block later messages of the same key — it's an exceptional,
       * manually-investigated state, and stalling every future event for the aggregate because one
       * message permanently failed would be worse than this documented ordering exception.
       */
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
