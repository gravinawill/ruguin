import { randomUUID } from 'node:crypto'

import { SESClient, VerifyEmailIdentityCommand } from '@aws-sdk/client-ses'
import { Test, type TestingModule } from '@nestjs/testing'
import { awsENV } from '@ruguin/env'
import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_TOPIC,
  EMAIL_STATUS_UPDATED_TOPIC
} from '@ruguin/event-schemas'
import {
  MESSAGE_CONSUMER_PORT,
  MESSAGE_PRODUCER_PORT,
  type MessageConsumerPort,
  type MessageProducerPort
} from '@ruguin/message-broker'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module.ts'

describe('Dispatch Worker end to end', () => {
  let producer: MessageProducerPort
  let consumer: MessageConsumerPort
  let moduleReference: TestingModule

  beforeAll(async () => {
    const sesClient = new SESClient({
      region: awsENV.AWS_REGION,
      ...(awsENV.AWS_ENDPOINT_URL !== undefined && { endpoint: awsENV.AWS_ENDPOINT_URL }),
      credentials: { accessKeyId: awsENV.AWS_ACCESS_KEY_ID, secretAccessKey: awsENV.AWS_SECRET_ACCESS_KEY }
    })
    await sesClient.send(new VerifyEmailIdentityCommand({ EmailAddress: awsENV.SES_FROM_ADDRESS }))

    /*
     * AppModule, not EmailModule directly — CacheModule/MessageBrokerModule are registered once,
     * globally, in AppModule (see its own comment), so this is what actually boots the way the
     * real process does.
     */
    moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    await moduleReference.init()

    producer = moduleReference.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    consumer = moduleReference.get<MessageConsumerPort>(MESSAGE_CONSUMER_PORT)
  })

  afterAll(async () => {
    await moduleReference.close()
  })

  it('sends a well-formed email and publishes email.status.updated with status=sent', async () => {
    const emailId = randomUUID()
    const statusEvents: unknown[] = []
    await consumer.subscribe({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      groupId: `e2e-status-${Date.now()}`,
      onMessage: (message) => {
        statusEvents.push(message.payload)
        return { isFailure: () => false, isSuccess: () => true, value: undefined } as never
      }
    })

    await producer.publish({
      topic: EMAIL_SEND_REQUESTED_TOPIC,
      key: emailId,
      message: {
        eventId: randomUUID(),
        name: 'email.send.requested',
        payload: {
          emailId,
          organizationId: randomUUID(),
          projectId: randomUUID(),
          from: awsENV.SES_FROM_ADDRESS,
          to: 'recipient@ruguin.dev',
          subject: 'E2E success',
          html: '<p>hi</p>',
          attempt: 0
        }
      }
    })

    await vi.waitUntil(() => statusEvents.some((event) => (event as { emailId: string }).emailId === emailId), {
      timeout: 15_000,
      interval: 200
    })

    expect(statusEvents).toContainEqual(expect.objectContaining({ emailId, status: 'sent' }))
  }, 20_000)

  it('exhausts retries and routes to the DLQ when the sender is rejected at the SES layer on every attempt', async () => {
    const emailId = randomUUID()
    const dlqMessages: unknown[] = []
    await consumer.subscribe({
      topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC,
      groupId: `e2e-dlq-${Date.now()}`,
      onMessage: (message) => {
        dlqMessages.push(message.payload)
        return { isFailure: () => false, isSuccess: () => true, value: undefined } as never
      }
    })

    /*
     * A literal `to: 'not-a-valid-address'` fails EmailSendRequestedPayloadSchema's own `to: z.email()`
     * check, so the main consumer's safeParse silently drops the message before it ever reaches
     * SendEmailUseCase/SES — the exact same "silently dropped, proves nothing" trap called out for
     * emailId/organizationId/projectId above, just missed for `to`. Verified directly against this
     * LocalStack that there's no fix for this within the "to" field: every zod-email-valid string tried
     * against SendEmailCommand's `to` was accepted (LocalStack's SES emulation validates recipients far
     * more loosely than zod's regex does). An unverified *sender* works instead: it's a normal address
     * that passes z.email() (so the message reaches SendEmailUseCase), and LocalStack SES deterministically
     * rejects every send from it with "Email address not verified" — since only `awsENV.SES_FROM_ADDRESS`
     * is ever verified in beforeAll, this fails identically on all 4 attempts below (main + 3 retries).
     */
    await producer.publish({
      topic: EMAIL_SEND_REQUESTED_TOPIC,
      key: emailId,
      message: {
        eventId: randomUUID(),
        name: 'email.send.requested',
        payload: {
          emailId,
          organizationId: randomUUID(),
          projectId: randomUUID(),
          from: 'unverified-sender@ruguin.dev',
          to: 'recipient@ruguin.dev',
          subject: 'E2E failure',
          html: '<p>hi</p>',
          attempt: 0
        }
      }
    })

    /*
     * The backoff chain alone sums to 10s + 20s + 40s = 70s (BASE_BACKOFF_MS=5000 from Task 14's
     * computeNextRetryAt, doubling per attempt) before the DLQ publish fires. Both this poll window and
     * the surrounding `it` timeout carry margin over that 70s floor for SES/Kafka round-trip latency and
     * first-subscription consumer group setup.
     */
    await vi.waitUntil(() => dlqMessages.some((message) => (message as { emailId: string }).emailId === emailId), {
      timeout: 85_000,
      interval: 500
    })

    expect(dlqMessages).toContainEqual(expect.objectContaining({ emailId }))
  }, 90_000)
})
