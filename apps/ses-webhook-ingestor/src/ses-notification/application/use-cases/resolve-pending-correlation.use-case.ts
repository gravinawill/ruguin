import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { publishExhaustedCorrelationToDlq } from '../../consumers/dlq-routing.ts'
import { CORRELATION_PROVIDER, type CorrelationPort } from '../../domain/contracts/correlation.port.ts'
import { computeNextCorrelationRetryAt, hasExhaustedCorrelationRetries } from '../correlation-retry-backoff.ts'

export type ResolvePendingCorrelationInput = Readonly<{
  sesMessageId: string
  status: string
  /*
   * Zod-optional fields infer as `T | undefined`, not just optional — match that spelling for
   * exactOptionalPropertyTypes compatibility when the retry consumer spreads its parsed payload in
   * directly (see apps/dispatch-worker's SendEmailUseCaseInput for the identical precedent).
   */
  bounceType?: string | undefined
  attempt: number
}>

export type ResolvePendingCorrelationOutcome = 'published' | 'retry-scheduled' | 'exhausted'
export type ResolvePendingCorrelationOutput = Readonly<{ outcome: ResolvePendingCorrelationOutcome }>

@Injectable()
export class ResolvePendingCorrelationUseCase {
  constructor(
    @Inject(CORRELATION_PROVIDER) private readonly correlation: CorrelationPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort
  ) {}

  public async execute(
    input: ResolvePendingCorrelationInput
  ): Promise<Either<BaseError, ResolvePendingCorrelationOutput>> {
    const lookup = await this.correlation.lookup({ sesMessageId: input.sesMessageId })
    if (lookup.isFailure()) return failure(lookup.value)

    if (lookup.value !== null) {
      const published = await this.producer.publish({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        key: lookup.value.emailId,
        message: {
          eventId: randomUUID(),
          name: 'email.status.updated',
          payload: {
            emailId: lookup.value.emailId,
            status: input.status,
            ...(input.bounceType !== undefined && { bounceType: input.bounceType })
          }
        }
      })
      if (published.isFailure()) return failure(published.value)

      return success({ outcome: 'published' })
    }

    const nextAttempt = input.attempt + 1

    if (hasExhaustedCorrelationRetries(nextAttempt)) {
      const dlq = await publishExhaustedCorrelationToDlq(this.producer, {
        sesMessageId: input.sesMessageId,
        status: input.status,
        attempt: nextAttempt,
        ...(input.bounceType !== undefined && { bounceType: input.bounceType })
      })
      if (dlq.isFailure()) return failure(dlq.value)

      return success({ outcome: 'exhausted' })
    }

    const nextAttemptAt = computeNextCorrelationRetryAt(nextAttempt)
    const rescheduled = await this.producer.publish({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      key: input.sesMessageId,
      message: {
        eventId: randomUUID(),
        name: 'ses.notification.correlation.pending',
        payload: {
          sesMessageId: input.sesMessageId,
          status: input.status,
          ...(input.bounceType !== undefined && { bounceType: input.bounceType })
        }
      },
      headers: { attempt: String(nextAttempt), nextAttemptAt: nextAttemptAt.toISOString() }
    })
    if (rescheduled.isFailure()) return failure(rescheduled.value)

    return success({ outcome: 'retry-scheduled' })
  }
}
