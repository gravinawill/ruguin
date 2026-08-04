import { Inject, Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'

import { OutboxStatus, Prisma } from '../database/prisma/generated/client'
import { PrismaService } from '../database/prisma/prisma.service'

/*
 * Known limitation, tracked for whoever splits this transaction up:
 * - publish() runs INSIDE the row-locking DB transaction (below), sequentially, for up to
 *   BATCH_SIZE rows. Against a real broker at ~250ms per publish, a full batch can approach the
 *   transaction timeout, aborting the whole batch and republishing already-delivered messages on
 *   the next tick (still at-least-once, but noisier). Splitting "publish" from "mark published"
 *   into separate short transactions removes this coupling without changing the delivery
 *   semantics — worth doing before this carries real traffic.
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
           * The due-ness check (nextAttemptAt) must apply AFTER candidate selection, not inside
           * the CTEs' WHERE — filtering it there would drop a row still in backoff out of its
           * group entirely, promoting a later message of the same key in its place. Selecting the
           * earliest PENDING row per (module, key) unconditionally and checking due-ness only on
           * that winner gives real head-of-line blocking: a key whose oldest message is in backoff
           * yields nothing until that message is due again.
           *
           * distinct_keys walks (module, key) pairs one at a time via index seeks ("loose index
           * scan": https://wiki.postgresql.org/wiki/Loose_indexscan) instead of ranking every
           * PENDING row with ROW_NUMBER() OVER (PARTITION BY ...) — that window function has to
           * read and sort every pending row across every key each tick even though only the batch's
           * worth of winners is ever used, so its cost grows with the whole backlog instead of with
           * BATCH_SIZE. This still visits one row per distinct (module, key) that has PENDING work,
           * so a backlog spread across many mostly-idle keys does not shrink much — it helps most
           * when a smaller number of keys are each carrying a deep backlog, which is the case an
           * outage or a slow consumer actually produces.
           *
           * candidates then grabs just the single earliest (createdAt, id) row per key found above,
           * via a LATERAL join — both walks are served by the same
           * outbox_messages_status_module_key_createdAt_id_idx index (status, module, key,
           * createdAt, id), so neither needs a new one.
           *
           * The ORDER BY tiebreaks on id after createdAt because createdAt alone is not unique: it
           * is TIMESTAMP(3) and Prisma stamps @default(now()) client-side on each insert, so a use
           * case enqueueing several events in one transaction collides on the millisecond routinely
           * (measured at 13-16 collisions per 40 consecutive enqueues). id is a UUID v7 from the
           * schema's @default(uuid(7)), verified monotonic within a millisecond, so ordering by it
           * restores enqueue order regardless of physical row order.
           *
           * Neither CTE holds row locks — a recursive CTE and FOR UPDATE cannot combine in the same
           * query, same restriction the prior window-function version had with FOR UPDATE. The
           * outer SELECT re-joins by primary key to lock only the winning row of each (module, key)
           * pair, so two relay instances racing on the same tick still never publish out of order:
           * SKIP LOCKED makes the loser skip a row someone else already grabbed instead of picking
           * a different one.
           *
           * The table is interpolated via Prisma.raw() because raw SQL doesn't inherit the
           * PrismaPg adapter's `schema` option the way `prisma.<model>.*` calls do — it needs the
           * schema identifier spelled out explicitly, derived the same way PrismaService derives
           * it.
           */
          const rows = await tx.$queryRaw<EligibleRow[]>`
            WITH RECURSIVE distinct_keys AS (
              (
                SELECT module, key
                FROM ${table}
                WHERE status = 'PENDING'
                ORDER BY module, key
                LIMIT 1
              )
              UNION ALL
              SELECT next.module, next.key
              FROM distinct_keys dk
              CROSS JOIN LATERAL (
                SELECT module, key
                FROM ${table}
                WHERE status = 'PENDING' AND (module, key) > (dk.module, dk.key)
                ORDER BY module, key
                LIMIT 1
              ) next
            ),
            candidates AS (
              SELECT earliest.id, earliest."createdAt", earliest."nextAttemptAt"
              FROM distinct_keys dk
              CROSS JOIN LATERAL (
                SELECT id, "createdAt", "nextAttemptAt"
                FROM ${table}
                WHERE status = 'PENDING' AND module = dk.module AND key = dk.key
                ORDER BY "createdAt", id
                LIMIT 1
              ) earliest
            )
            SELECT o.id, o."createdAt", o."eventId", o.module, o.topic, o.key, o.name, o.payload, o.attempts
            FROM ${table} o
            JOIN candidates c ON c.id = o.id AND c."createdAt" = o."createdAt"
            WHERE (c."nextAttemptAt" IS NULL OR c."nextAttemptAt" <= now())
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
        message: { eventId: row.eventId, name: row.name, payload: row.payload },
        topic: row.topic
      })

      return published.isFailure() ? published.value.message : null
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}
