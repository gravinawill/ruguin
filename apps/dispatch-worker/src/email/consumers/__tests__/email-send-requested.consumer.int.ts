import { randomUUID } from 'node:crypto'

import { SESClient, VerifyEmailIdentityCommand } from '@aws-sdk/client-ses'
import { Test, type TestingModule } from '@nestjs/testing'
import { EMAIL_SEND_REQUESTED_TOPIC, EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../app.module.ts'

const FROM_ADDRESS = 'sender@ruguin.dev'

const isStatusUpdated = ([call]: Parameters<MessageProducerPort['publish']>): boolean =>
  call.topic === EMAIL_STATUS_UPDATED_TOPIC

describe('EmailSendRequestedConsumer (real Kafka + Redis)', () => {
  let moduleReference: TestingModule

  /*
   * In afterEach, not at the end of the test body — if vi.waitUntil times out or an assertion
   * below fails, a close() only at the end of a linear test body never runs, and the Kafka
   * consumer / Redis connection / SES client this module opened stay open, leaking into
   * whatever runs next in this Vitest worker.
   */
  afterEach(async () => {
    await moduleReference.close()
  })

  it('consumes email.send.requested and eventually publishes email.status.updated', async () => {
    /*
     * AppModule, not EmailModule directly — CacheModule/MessageBrokerModule are registered once,
     * globally, in AppModule (see its own comment), so this is what actually boots the way the
     * real process does.
     */
    moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    await moduleReference.init()

    /*
     * LocalStack's SES emulation rejects sends from an unverified identity (a real behavior, not a
     * LocalStack-only quirk — this mirrors production SES sandbox rules). Verification is per
     * LocalStack-container state, not per test run, so a fresh `pnpm infra:up`/`infra:reset` has no
     * verified identities yet; do it here so this test is self-contained rather than depending on a
     * manual setup step. Idempotent — re-verifying an already-verified identity is a no-op.
     */
    const sesClient = moduleReference.get(SESClient)
    await sesClient.send(new VerifyEmailIdentityCommand({ EmailAddress: FROM_ADDRESS }))

    const producer = moduleReference.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const publishSpy = vi.spyOn(producer, 'publish')

    /*
     * emailId/organizationId/projectId must be real UUIDs and from/to real emails — this is what
     * EmailSendRequestedPayloadSchema.safeParse requires. A payload that fails validation is now
     * routed to the DLQ (see email-send-requested.consumer.ts) instead of driving
     * SendEmailUseCase, so an invalid payload here would make this test wait out its timeout
     * without ever proving the send chain actually ran.
     */
    const emailId = randomUUID()

    await producer.publish({
      topic: EMAIL_SEND_REQUESTED_TOPIC,
      key: emailId,
      message: {
        eventId: 'evt-int-1',
        name: 'email.send.requested',
        payload: {
          emailId,
          organizationId: randomUUID(),
          projectId: randomUUID(),
          from: FROM_ADDRESS,
          to: 'recipient@ruguin.dev',
          subject: 'Integration test',
          html: '<p>hi</p>',
          text: 'hi'
        }
      }
    })

    await vi.waitUntil(() => publishSpy.mock.calls.some((call) => isStatusUpdated(call)), {
      timeout: 15_000,
      interval: 200
    })

    const callIndex = publishSpy.mock.calls.findIndex((call) => isStatusUpdated(call))
    const [statusUpdatedCall] = publishSpy.mock.calls[callIndex]!
    expect(statusUpdatedCall.message.payload).toMatchObject({ emailId, status: 'sent' })

    /*
     * vi.spyOn records a call the moment publish() is invoked, regardless of whether it later
     * resolves to success(...) or failure(...) — so the assertions above only prove a status update
     * was *attempted* with the right payload, not that it actually reached Kafka. Await the same
     * settled call to confirm the full chain really completed.
     */
    const outcome = await publishSpy.mock.results[callIndex]!.value
    expect(outcome.isSuccess()).toBe(true)
  }, 20_000)
})
