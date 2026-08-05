import { randomUUID } from 'node:crypto'

import { Test, type TestingModule } from '@nestjs/testing'
import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../app.module.ts'
import { createTestPrismaService } from '../../../shared/infrastructure/database/prisma/__tests__/database-test-context.ts'
import { type PrismaService } from '../../../shared/infrastructure/database/prisma/prisma.service.ts'

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
})

const isStatusUpdated = ([call]: Parameters<MessageProducerPort['publish']>): boolean =>
  call.topic === EMAIL_STATUS_UPDATED_TOPIC

describe('SesNotificationCorrelationRetryConsumer (real Kafka + Postgres)', () => {
  let moduleReference: TestingModule
  let prisma: PrismaService

  beforeAll(() => {
    prisma = createTestPrismaService()
  })

  afterEach(async () => {
    await moduleReference.close()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('resolves once the correlation exists and publishes email.status.updated', async () => {
    moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    await moduleReference.init()

    const emailId = randomUUID()
    const sesMessageId = `int-test-retry-${randomUUID()}`
    await prisma.sesMessageCorrelation.create({ data: { sesMessageId, emailId } })

    const producer = moduleReference.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const publishSpy = vi.spyOn(producer, 'publish')

    await producer.publish({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      key: sesMessageId,
      message: {
        eventId: 'evt-retry-1',
        name: 'ses.notification.correlation.pending',
        payload: { sesMessageId, status: 'delivered' }
      },
      headers: { attempt: '1', nextAttemptAt: new Date().toISOString() }
    })

    await vi.waitUntil(() => publishSpy.mock.calls.some((call) => isStatusUpdated(call)), {
      timeout: 15_000,
      interval: 200
    })

    const callIndex = publishSpy.mock.calls.findIndex((call) => isStatusUpdated(call))
    const [statusUpdatedCall] = publishSpy.mock.calls[callIndex]!
    expect(statusUpdatedCall.message.payload).toMatchObject({ emailId, status: 'delivered' })

    await prisma.sesMessageCorrelation.delete({ where: { sesMessageId } })
  }, 20_000)
})
