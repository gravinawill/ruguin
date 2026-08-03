import { type DynamicModule, Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { MESSAGE_PRODUCER_PORT } from '../../domain/contracts/message-producer.port'
import { OUTBOX_PORT } from '../../domain/contracts/outbox.port'
import { FakeMessageProducer } from '../events/fake-message-producer'

import { OutboxRepository } from './outbox.repository'
import { OutboxPartitionMaintenanceService } from './outbox-partition-maintenance.service'
import { OutboxRelayService } from './outbox-relay.service'

/*
 * forRoot() and forFeature() are both static factories rather than fixed `@Module({...})`
 * metadata: Nest concatenates a class's static decorator metadata onto every DynamicModule it
 * returns, rather than replacing it. If OutboxRelayService/OutboxPartitionMaintenanceService lived
 * in the static @Module decorator, every forFeature() call (one per business module) would get its
 * own instance of both — and OutboxPartitionMaintenanceService running concurrently across
 * instances races on the same DDL (CREATE/DROP PARTITION). Each factory below declares only what
 * it needs, so forRoot() (called once, in AppModule) owns the relay/scheduler, and forFeature()
 * (called once per business module) owns only that module's OUTBOX_PORT binding.
 */
@Module({})
export class OutboxModule {
  public static forRoot(): DynamicModule {
    return {
      imports: [ScheduleModule.forRoot()],
      module: this,
      providers: [
        { provide: MESSAGE_PRODUCER_PORT, useClass: FakeMessageProducer },
        OutboxRelayService,
        OutboxPartitionMaintenanceService
      ]
    }
  }

  public static forFeature(input: { module: string }): DynamicModule {
    return {
      exports: [OUTBOX_PORT],
      module: this,
      providers: [{ provide: OUTBOX_PORT, useValue: new OutboxRepository(input.module) }]
    }
  }
}
