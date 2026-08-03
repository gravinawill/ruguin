import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OUTBOX_PORT } from '../../../domain/contracts/outbox.port'
import { DatabaseModule } from '../../database/database.module'
import { OutboxModule } from '../outbox.module'
import { OutboxPartitionMaintenanceService } from '../outbox-partition-maintenance.service'
import { OutboxRelayService } from '../outbox-relay.service'

import { TEST_DATABASE_URL } from './outbox-test-context'

const database = (): ReturnType<typeof DatabaseModule.forRoot> =>
  DatabaseModule.forRoot({ connectionString: TEST_DATABASE_URL })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OutboxModule composition', () => {
  it('forRoot() runs partition maintenance once the app finishes booting', async () => {
    const runMaintenance = vi.spyOn(OutboxPartitionMaintenanceService.prototype, 'runMaintenance')

    const moduleReference = await Test.createTestingModule({ imports: [database(), OutboxModule.forRoot()] }).compile()
    const app = moduleReference.createNestApplication()

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
