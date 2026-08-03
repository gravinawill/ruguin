import { Inject, Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { type JsonValue } from '@ruguin/shared-domain'

import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '../../domain/contracts/message-producer.port'
import { OutboxStatus, Prisma } from '../database/prisma/generated/client'
import { PrismaService } from '../database/prisma/prisma.service'

/*
 * Known limitations, tracked for whoever plugs in the real Kafka producer:
 * - publish() runs INSIDE the row-locking DB transaction (below), sequentially, for up to
 *   BATCH_SIZE rows. With a fast in-memory fake this is instant; with a real broker at ~250ms per
 *   publish, a full batch can approach the transaction timeout, aborting the whole batch and
 *   republishing already-delivered messages on the next tick (still at-least-once, but noisier).
 *   Splitting "publish" from "mark published" into separate short transactions removes this
 *   coupling without changing the delivery semantics — worth doing before this carries real
 *   traffic.
 * - MESSAGE_PRODUCER_PORT defaults to FakeMessageProducer (see OutboxModule) until that real
 *   producer lands — see FakeMessageProducer's own warning log.
 */
const RELAY_INTERVAL_MS = 1000
const RELAY_TRANSACTION_TIMEOUT_MS = 5000
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
  private isRunning = false

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly messageProducer: MessageProducerPort
  ) {}

  @Interval(RELAY_INTERVAL_MS)
  public async relay(): Promise<void> {
    /*
     * A slow tick (broker latency, DB contention) must not stack a second transaction on top of
     * the first — @Interval has no built-in overlap guard.
     */
    if (this.isRunning) return

    this.isRunning = true

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const table = Prisma.raw(`"${this.prisma.schema}"."outbox_messages"`)

          /*
           * The due-ness check (nextAttemptAt) must apply AFTER ranking, not inside the ranked
           * CTE's WHERE — filtering it there would drop a row still in backoff out of its
           * partition entirely, letting ROW_NUMBER() re-rank around it and publish a later
           * message of the same key first. Ranking over every PENDING row (backoff or not) and
           * checking due-ness only on the winner gives real head-of-line blocking: a key whose
           * oldest message is in backoff yields nothing until that message is due again.
           *
           * The ORDER BY tiebreaks on id after createdAt because createdAt alone is not unique:
           * it is TIMESTAMP(3) and Prisma stamps @default(now()) client-side on each insert, so a
           * use case enqueueing several events in one transaction collides on the millisecond
           * routinely (measured at 13-16 collisions per 40 consecutive enqueues). Ties are not
           * benign — this query ranks over a Seq Scan feeding a Sort, so a tie resolves by physical
           * heap position, and any UPDATE (a retry bumping attempts) rewrites the row at the end of
           * the heap, silently inverting publish order on the following tick. id is a UUID v7 from
           * the schema's @default(uuid(7)), verified monotonic within a millisecond, so ordering by
           * it restores enqueue order.
           *
           * The table is interpolated via Prisma.raw() because raw SQL doesn't inherit the
           * PrismaPg adapter's `schema` option the way `prisma.<model>.*` calls do — it needs the
           * schema identifier spelled out explicitly, derived the same way PrismaService derives
           * it.
           */
          const rows = await tx.$queryRaw<EligibleRow[]>`
            WITH ranked AS (
              SELECT id, "createdAt", "nextAttemptAt",
                     ROW_NUMBER() OVER (PARTITION BY module, key ORDER BY "createdAt", id) AS rn
              FROM ${table}
              WHERE status = 'PENDING'
            )
            SELECT o.id, o."createdAt", o."eventId", o.module, o.topic, o.key, o.name, o.payload, o.attempts
            FROM ${table} o
            JOIN ranked r ON r.id = o.id AND r."createdAt" = o."createdAt"
            WHERE r.rn = 1
              AND (r."nextAttemptAt" IS NULL OR r."nextAttemptAt" <= now())
            ORDER BY o."createdAt", o.id
            LIMIT ${BATCH_SIZE}
            FOR UPDATE OF o SKIP LOCKED
          `

          for (const row of rows) {
            await this.processRow(tx, row)
          }
        },
        { timeout: RELAY_TRANSACTION_TIMEOUT_MS }
      )
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined
      this.logger.error(`Outbox relay tick failed: ${message}`, stack)
    } finally {
      this.isRunning = false
    }
  }

  private async processRow(tx: Prisma.TransactionClient, row: EligibleRow): Promise<void> {
    const publishError = await this.publish(row)

    if (publishError === null) {
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
        data: { attempts, lastError: publishError, status: OutboxStatus.FAILED },
        where: { id_createdAt: { createdAt: row.createdAt, id: row.id } }
      })
      this.logger.error(`Outbox message ${row.id} moved to FAILED after ${attempts} attempts.`)
      return
    }

    await tx.outboxMessage.update({
      data: { attempts, lastError: publishError, nextAttemptAt: computeNextAttemptAt(attempts) },
      where: { id_createdAt: { createdAt: row.createdAt, id: row.id } }
    })
  }

  /*
   * MessageProducerPort.publish() is typed to return Either, but a real broker client can still
   * reject instead of catching its own failure — a DNS error, a serialization bug, anything the
   * producer author didn't anticipate. Left uncaught, that rejection propagates out of the
   * $transaction callback: the whole batch rolls back, attempts/nextAttemptAt are never persisted
   * for ANY row in it, and the next tick retries the same row immediately — a hot loop with no
   * backoff instead of the failure path this method already models. Converting a thrown error into
   * the same publishError shape it already handles keeps that one behavior true regardless of
   * which failure mode the producer hits.
   */
  private async publish(row: EligibleRow): Promise<string | null> {
    try {
      const published = await this.messageProducer.publish({
        key: row.key,
        /*
         * Prisma's JsonValue treats object properties as optional, so it does not structurally
         * satisfy the domain JsonValue's non-optional index signature — the column is validated
         * JSON either way, so this is a plain infra-to-domain type translation, not a runtime risk.
         */
        message: { eventId: row.eventId, name: row.name, payload: row.payload as JsonValue },
        topic: row.topic
      })

      return published.isFailure() ? published.value.message : null
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}
