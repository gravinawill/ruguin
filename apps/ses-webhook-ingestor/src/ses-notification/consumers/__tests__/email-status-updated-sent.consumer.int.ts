import { randomUUID } from 'node:crypto'

import { Test, type TestingModule } from '@nestjs/testing'
import { EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../app.module.ts'
import { createTestPrismaService } from '../../../shared/infrastructure/database/prisma/__tests__/database-test-context.ts'
import { type PrismaService } from '../../../shared/infrastructure/database/prisma/prisma.service.ts'

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
})

describe('EmailStatusUpdatedSentConsumer (real Kafka + Postgres)', () => {
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

  it('records a correlation row when a sent status event is consumed', async () => {
    moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    await moduleReference.init()

    const producer = moduleReference.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const emailId = randomUUID()
    const sesMessageId = `int-test-sent-${randomUUID()}`

    await producer.publish({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      key: emailId,
      message: {
        eventId: 'evt-sent-1',
        name: 'email.status.updated',
        payload: { emailId, status: 'sent', sesMessageId }
      }
    })

    await vi.waitUntil(
      async () => (await prisma.sesMessageCorrelation.findUnique({ where: { sesMessageId } })) !== null,
      { timeout: 15_000, interval: 200 }
    )

    const row = await prisma.sesMessageCorrelation.findUnique({ where: { sesMessageId } })
    expect(row).toMatchObject({ sesMessageId, emailId })

    await prisma.sesMessageCorrelation.delete({ where: { sesMessageId } })
  }, 20_000)
})
