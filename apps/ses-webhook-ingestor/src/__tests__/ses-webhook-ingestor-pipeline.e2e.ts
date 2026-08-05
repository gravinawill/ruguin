import { randomUUID } from 'node:crypto'

import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test, type TestingModule } from '@nestjs/testing'
import { EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort, type OutboundMessage } from '@ruguin/message-broker'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../app.module.ts'
import { SES_INGESTOR_SECRET_HEADER } from '../ses-notification/presentation/ses-webhook-auth.guard.ts'
import { createTestPrismaService } from '../shared/infrastructure/database/prisma/__tests__/database-test-context.ts'
import { type PrismaService } from '../shared/infrastructure/database/prisma/prisma.service.ts'

const SHARED_SECRET = 'pipeline-e2e-secret'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-pipeline'
  process.env.CACHE_DRIVER = 'memory'
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
  process.env.SES_WEBHOOK_INGESTOR_SHARED_SECRET = 'pipeline-e2e-secret'
})

function findBouncedPublish(calls: Array<[OutboundMessage]>): OutboundMessage | undefined {
  const found = calls.find(
    ([call]) =>
      call.topic === EMAIL_STATUS_UPDATED_TOPIC && (call.message.payload as { status?: string }).status === 'bounced'
  )
  return found?.[0]
}

describe('SES webhook ingestor — full pipeline', () => {
  let app: INestApplication
  let moduleReference: TestingModule
  let testPrisma: PrismaService

  beforeAll(async () => {
    testPrisma = createTestPrismaService()
    moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await (app as unknown as NestFastifyApplication).getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
    await testPrisma.$disconnect()
  })

  it('correlates a sent email to a bounce notification and republishes email.status.updated', async () => {
    const producer = moduleReference.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const publishSpy = vi.spyOn(producer, 'publish')

    const emailId = randomUUID()
    const sesMessageId = `pipeline-e2e-${randomUUID()}`

    // Step 1: simulate dispatch-worker's own "sent" event.
    await producer.publish({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      key: emailId,
      message: {
        eventId: 'evt-pipeline-sent',
        name: 'email.status.updated',
        payload: { emailId, status: 'sent', sesMessageId }
      }
    })

    /*
     * Step 2: wait for the correlation consumer (Task 9) to record the row in Postgres — polling
     * the actual side effect, not a fixed sleep, so this can't flake under a slow CI runner.
     */
    await vi.waitUntil(
      async () => (await testPrisma.sesMessageCorrelation.findUnique({ where: { sesMessageId } })) !== null,
      { timeout: 15_000, interval: 200 }
    )

    // Step 3: POST the EventBridge-shaped SES bounce notification.
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/webhooks/ses',
        headers: { [SES_INGESTOR_SECRET_HEADER]: SHARED_SECRET },
        payload: {
          id: `evt-pipeline-bounce-${randomUUID()}`,
          source: 'aws.ses',
          detail: { eventType: 'Bounce', mail: { messageId: sesMessageId }, bounce: { bounceType: 'Permanent' } }
        }
      })

    expect(response.statusCode).toBe(200)

    /*
     * Step 4: confirm email.status.updated carries the right emailId/status/bounceType — this
     * passes whether the lookup found the row immediately or fell back to the retry topic
     * (Task 14), since both paths publish the same event.
     */
    await vi.waitUntil(() => findBouncedPublish(publishSpy.mock.calls as Array<[OutboundMessage]>) !== undefined, {
      timeout: 20_000,
      interval: 200
    })

    const bouncedMessage = findBouncedPublish(publishSpy.mock.calls)
    expect(bouncedMessage?.message.payload).toMatchObject({ emailId, status: 'bounced', bounceType: 'Permanent' })

    await testPrisma.sesMessageCorrelation.delete({ where: { sesMessageId } })
  }, 40_000)
})
