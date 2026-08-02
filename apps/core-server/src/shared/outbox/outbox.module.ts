import { type DynamicModule, Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { MESSAGE_PRODUCER_PORT } from '../contracts/message-producer.port'
import { OUTBOX_PORT } from '../contracts/outbox.port'
import { FakeMessageProducer } from '../events/fake-message-producer'

import { OutboxRepository } from './outbox.repository'
import { OutboxPartitionMaintenanceService } from './outbox-partition-maintenance.service'
import { OutboxRelayService } from './outbox-relay.service'

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    { provide: MESSAGE_PRODUCER_PORT, useClass: FakeMessageProducer },
    OutboxRelayService,
    OutboxPartitionMaintenanceService
  ]
})
export class OutboxModule {
  public static forFeature(input: { module: string }): DynamicModule {
    return {
      exports: [OUTBOX_PORT],
      module: this,
      providers: [{ provide: OUTBOX_PORT, useValue: new OutboxRepository(input.module) }]
    }
  }
}
