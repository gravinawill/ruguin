import { Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'

import { SyncSenderIdentityVerificationUseCase } from '../../application/use-cases/sync-sender-identity-verification.use-case'

/*
 * Env-configurable intervals can't be read from an @Interval decorator argument — see this plan's
 * Global Constraints. Matches OutboxRelayService's own RELAY_INTERVAL_MS precedent.
 */
const SYNC_INTERVAL_MS = 60_000

@Injectable()
export class SenderIdentitySyncService {
  private readonly logger = new Logger(SenderIdentitySyncService.name)
  private isRunning = false

  constructor(private readonly syncUseCase: SyncSenderIdentityVerificationUseCase) {}

  @Interval(SYNC_INTERVAL_MS)
  public async sync(): Promise<void> {
    /*
     * Same overlap guard as OutboxRelayService: @Interval has none built in, and a slow tick (many
     * unverified rows, a slow SES response) must not stack a second sweep on top of the first.
     */
    if (this.isRunning) return

    this.isRunning = true
    try {
      await this.syncUseCase.execute()
    } catch (error: unknown) {
      /*
       * The use case itself never throws (every branch logs and returns) — this is a last-resort
       * net so a bug there can never crash the interval timer and silently stop all future syncs.
       */
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined
      this.logger.error(`Sender identity sync tick failed: ${message}`, stack)
    } finally {
      this.isRunning = false
    }
  }
}
