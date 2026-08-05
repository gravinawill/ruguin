import { Body, Controller, HttpCode, InternalServerErrorException, Logger, Post, UseGuards } from '@nestjs/common'

import {
  type IngestSesNotificationInput,
  IngestSesNotificationUseCase
} from '../application/use-cases/ingest-ses-notification.use-case.ts'
import { SesNotificationEvent } from '../domain/models/ses-notification-event.model.ts'

import { EventBridgeSesNotificationSchema } from './dto/eventbridge-ses-notification.schema.ts'
import { SesWebhookAuthGuard } from './ses-webhook-auth.guard.ts'

@Controller('webhooks')
export class SesWebhookController {
  private readonly logger = new Logger(SesWebhookController.name)

  constructor(private readonly ingestSesNotification: IngestSesNotificationUseCase) {}

  @UseGuards(SesWebhookAuthGuard)
  @Post('ses')
  @HttpCode(200)
  public async handle(@Body() body: unknown): Promise<{ status: 'ok' }> {
    const result = await this.ingestSesNotification.execute(this.toUseCaseInput(body))

    /*
     * Every non-failure outcome (published, malformed-dlq, duplicate-skipped, lookup-pending) means
     * the notification was accepted and handled — 200 either way. Only a genuine infra failure (a
     * Kafka publish that didn't go through) is worth a 5xx, so EventBridge's own retry policy gets
     * a chance to redeliver it.
     */
    if (result.isFailure()) throw new InternalServerErrorException()

    return { status: 'ok' }
  }

  /*
   * Parsing the EventBridge envelope is a transport/presentation concern — it belongs at this
   * boundary, not inside the use case. Whatever comes out (a validated domain event, or an explicit
   * "malformed" signal) is the only shape IngestSesNotificationUseCase ever sees.
   *
   * Both rejections are logged here, matching every other malformed-payload path in this module:
   * the reason reaches the DLQ payload either way, but the warning is what an alert rule watches.
   * The route is behind SesWebhookAuthGuard, so this is not an open-internet log-volume risk.
   */
  private toUseCaseInput(body: unknown): IngestSesNotificationInput {
    const parsed = EventBridgeSesNotificationSchema.safeParse(body)
    if (!parsed.success) {
      this.logger.warn(`Malformed EventBridge SES notification: ${parsed.error.message}; routing to DLQ.`)
      return { kind: 'malformed', rawBody: body, reason: parsed.error.message }
    }

    const event = SesNotificationEvent.create({
      sesMessageId: parsed.data.detail.mail.messageId,
      eventType: parsed.data.detail.eventType,
      ...(parsed.data.detail.eventType === 'Bounce' && { bounceType: parsed.data.detail.bounce.bounceType })
    })
    if (event.isFailure()) {
      this.logger.warn(
        `Invalid SES notification in EventBridge event ${parsed.data.id}: ${event.value.message}; routing to DLQ.`
      )
      return { kind: 'malformed', rawBody: body, reason: event.value.message }
    }

    return { kind: 'valid', eventBridgeId: parsed.data.id, event: event.value }
  }
}
