import { Global, Module } from '@nestjs/common'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { MESSAGE_PRODUCER_PORT } from '@ruguin/message-broker'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OUTBOX_PORT } from '../../../domain/contracts/outbox.port'
import { DatabaseModule } from '../../database/database.module'
import { FakeMessageProducer } from '../../events/fake-message-producer'
import { OutboxModule } from '../outbox.module'
import { OutboxPartitionMaintenanceService } from '../outbox-partition-maintenance.service'
import { OutboxRelayService } from '../outbox-relay.service'

import { TEST_DATABASE_URL } from './outbox-test-context'

const database = (): ReturnType<typeof DatabaseModule.forRoot> =>
  DatabaseModule.forRoot({ connectionString: TEST_DATABASE_URL })

/*
 * OutboxModule.forRoot() no longer provides MESSAGE_PRODUCER_PORT itself — production wiring
 * relies on AppModule registering @ruguin/message-broker's MessageBrokerModule globally (see
 * outbox.module.ts's own comment). Nest's DI only flows downward through imports/exports, so a
 * plain provider on the root testing module is invisible to OutboxModule as a nested import; it
 * has to be global, the same way MessageBrokerModule.forRoot({ isGlobal: true }) is in production.
 * This test is about OutboxModule's own composition (partition maintenance timing, forFeature
 * scoping), not messaging, so a fake stands in rather than a real Kafka connection.
 */
@Global()
@Module({
  providers: [{ provide: MESSAGE_PRODUCER_PORT, useClass: FakeMessageProducer }],
  exports: [MESSAGE_PRODUCER_PORT]
})
class FakeMessageBrokerModule {}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OutboxModule composition', () => {
  it('forRoot() runs partition maintenance once the app finishes booting', async () => {
    const runMaintenance = vi.spyOn(OutboxPartitionMaintenanceService.prototype, 'runMaintenance')

    const moduleReference = await Test.createTestingModule({
      imports: [FakeMessageBrokerModule, database(), OutboxModule.forRoot()]
    }).compile()
    const app = moduleReference.createNestApplication(new FastifyAdapter())

    try {
      expect(runMaintenance).not.toHaveBeenCalled()

      await app.init()

      /*
       * Exactly once, not once per import: partitions are created and dropped with raw DDL, so a
       * second concurrent instance in the same process would race against this one.
       */
      expect(runMaintenance).toHaveBeenCalledTimes(1)
    } finally {
      await app.close()
    }
  })

  it('forFeature() contributes only the module OUTBOX_PORT, never a second relay or maintenance cron', async () => {
    /*
     * Nest concatenates a class's static @Module metadata onto every DynamicModule it returns, so
     * anything declared in the decorator would be duplicated once per business module. Keeping the
     * decorator empty is what stops N business modules from producing N relays and N cron jobs —
     * this asserts that neither leaks in through forFeature().
     */
    const moduleReference = await Test.createTestingModule({
      imports: [database(), OutboxModule.forFeature({ module: 'outbox-module-int-test' })]
    }).compile()

    try {
      expect(moduleReference.get(OUTBOX_PORT, { strict: false })).toBeDefined()
      expect(() => moduleReference.get(OutboxRelayService, { strict: false })).toThrow()
      expect(() => moduleReference.get(OutboxPartitionMaintenanceService, { strict: false })).toThrow()
    } finally {
      await moduleReference.close()
    }
  })
})
