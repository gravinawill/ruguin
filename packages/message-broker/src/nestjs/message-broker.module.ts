import { type DynamicModule, Module } from '@nestjs/common'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { Consumer, Producer, stringDeserializers, stringSerializers } from '@platformatic/kafka'
import { KafkaInstrumentation } from '@platformatic/kafka-opentelemetry'

import { MESSAGE_CONSUMER_PORT } from '../domain/contracts/message-consumer.port.ts'
import { MESSAGE_PRODUCER_PORT } from '../domain/contracts/message-producer.port.ts'
import { type CreateConsumer, KafkaMessageConsumer } from '../infra/kafka/kafka-message-consumer.ts'
import { KafkaMessageProducer } from '../infra/kafka/kafka-message-producer.ts'

import { KAFKA_PRODUCER } from './message-broker.tokens.ts'

export type MessageBrokerModuleOptions = Readonly<{
  brokers: readonly string[]
  clientId: string
  ssl?: boolean
  /**
   * @platformatic/kafka defaults to false — publishing/subscribing to a topic that doesn't exist
   * yet then hangs instead of creating it. Each app's own options builder decides this explicitly
   * (see apps/core-server and apps/dispatch-worker's createMessageBrokerModuleOptions()) rather
   * than this package defaulting it — a production broker with deliberate topic provisioning
   * should be able to turn this off without touching shared code.
   */
  autoCreateTopics?: boolean
  isGlobal?: boolean
}>

/*
 * Registered once at module-load time (ESM modules are evaluated once per process), not inside
 * forRoot() — forRoot() can run more than once if multiple apps import this module in the same
 * process (not the case today, but registerInstrumentations() is not idempotent-safe to call
 * per-DynamicModule construction).
 */
// eslint-disable-next-line unicorn/no-top-level-side-effects -- must run once at module load, see comment above
registerInstrumentations({ instrumentations: [new KafkaInstrumentation()] })

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS dynamic-module convention: forRoot() is the only API surface
export class MessageBrokerModule {
  public static forRoot(options: MessageBrokerModuleOptions): DynamicModule {
    const { isGlobal = false, ...config } = options

    const createConsumer: CreateConsumer = (groupId) =>
      new Consumer<string, string, string, string>({
        groupId,
        clientId: config.clientId,
        bootstrapBrokers: [...config.brokers],
        deserializers: stringDeserializers,
        autocreateTopics: config.autoCreateTopics ?? false,
        ...(config.ssl === true && { tls: {} })
      })

    return {
      module: this,
      global: isGlobal,
      providers: [
        {
          provide: KAFKA_PRODUCER,
          useFactory: (): Producer<string, string, string, string> =>
            new Producer<string, string, string, string>({
              clientId: config.clientId,
              bootstrapBrokers: [...config.brokers],
              serializers: stringSerializers,
              autocreateTopics: config.autoCreateTopics ?? false,
              ...(config.ssl === true && { tls: {} })
            })
        },
        {
          provide: MESSAGE_PRODUCER_PORT,
          useFactory: (producer: Producer<string, string, string, string>): KafkaMessageProducer =>
            new KafkaMessageProducer(producer),
          inject: [KAFKA_PRODUCER]
        },
        {
          provide: MESSAGE_CONSUMER_PORT,
          useFactory: (): KafkaMessageConsumer => new KafkaMessageConsumer(createConsumer)
        }
      ],
      exports: [MESSAGE_PRODUCER_PORT, MESSAGE_CONSUMER_PORT]
    }
  }
}
