import { Body, Controller, HttpCode, InternalServerErrorException, Post, UseGuards } from '@nestjs/common'

import { IngestSesNotificationUseCase } from '../application/use-cases/ingest-ses-notification.use-case.ts'

import { SesWebhookAuthGuard } from './ses-webhook-auth.guard.ts'

@Controller('webhooks')
export class SesWebhookController {
  constructor(private readonly ingestSesNotification: IngestSesNotificationUseCase) {}

  @UseGuards(SesWebhookAuthGuard)
  @Post('ses')
  @HttpCode(200)
  public async handle(@Body() body: unknown): Promise<{ status: 'ok' }> {
    const result = await this.ingestSesNotification.execute({ body })
    /*
     * Every non-failure outcome from the use case (published, malformed-dlq, duplicate-skipped,
     * lookup-pending) means the notification was accepted and handled — 200 either way. Only a
     * genuine infra failure (a Kafka publish that didn't go through) is worth a 5xx, so
     * EventBridge's own retry policy gets a chance to redeliver it.
     */
    if (result.isFailure()) throw new InternalServerErrorException()

    return { status: 'ok' }
  }
}
