import { SES_NOTIFICATION_CORRELATION_RETRY_TOPIC, SES_NOTIFICATION_MALFORMED_DLQ_TOPIC } from '@ruguin/event-schemas'
import { type MessageConsumerPort, type MessageProducerPort, type SubscribeInput } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type ResolvePendingCorrelationUseCase } from '../../application/use-cases/resolve-pending-correlation.use-case.ts'
import {
  CORRELATION_RETRY_CONSUMER_GROUP_ID,
  SesNotificationCorrelationRetryConsumer
} from '../ses-notification-correlation-retry.consumer.ts'

describe('SesNotificationCorrelationRetryConsumer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes to the correlation retry topic under its own consumer group', async () => {
    let subscribeInput: SubscribeInput | undefined
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput): Promise<Either<BaseError, void>> => {
        subscribeInput = input
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn().mockResolvedValue(success({ outcome: 'published' }))
    const resolvePendingCorrelation = { execute } as unknown as ResolvePendingCorrelationUseCase

    await new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation).onModuleInit()

    expect(subscribeInput?.topic).toBe(SES_NOTIFICATION_CORRELATION_RETRY_TOPIC)
    expect(subscribeInput?.groupId).toBe(CORRELATION_RETRY_CONSUMER_GROUP_ID)
  })

  it('fails bootstrap when the subscription itself fails, instead of running with a dead consumer', async () => {
    const fakeConsumer: MessageConsumerPort = {
      subscribe: vi.fn().mockResolvedValue(failure({ name: 'MessageConsumeError', message: 'broker unavailable' }))
    }
    const producer = { publish: vi.fn() } as unknown as MessageProducerPort
    const resolvePendingCorrelation = { execute: vi.fn() } as unknown as ResolvePendingCorrelationUseCase

    const consumer = new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation)

    await expect(consumer.onModuleInit()).rejects.toThrow('broker unavailable')
  })

  it('waits until nextAttemptAt before calling the use case, then passes the parsed payload and header attempt through', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput): Promise<Either<BaseError, void>> => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn().mockResolvedValue(success({ outcome: 'published' }))
    const resolvePendingCorrelation = { execute } as unknown as ResolvePendingCorrelationUseCase

    await new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation).onModuleInit()

    const messagePromise = onMessage({
      eventId: 'evt-1',
      name: 'ses.notification.correlation.pending',
      payload: { sesMessageId: 'ses-msg-1', status: 'bounced', bounceType: 'Permanent' },
      headers: { attempt: '1', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    await vi.advanceTimersByTimeAsync(10_000)
    await messagePromise

    expect(execute).toHaveBeenCalledWith({
      sesMessageId: 'ses-msg-1',
      status: 'bounced',
      bounceType: 'Permanent',
      attempt: 1
    })
  })

  it('routes a schema-invalid payload to the DLQ instead of dropping it', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput): Promise<Either<BaseError, void>> => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn()
    const resolvePendingCorrelation = { execute } as unknown as ResolvePendingCorrelationUseCase

    await new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-malformed-retry-1',
      name: 'ses.notification.correlation.pending',
      payload: { sesMessageId: 'ses-msg-1', status: 'not-a-real-status' },
      headers: {}
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC, key: expect.any(String) })
    )
  })

  it('routes to the DLQ instead of retry-looping forever when the attempt header is not a number', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput): Promise<Either<BaseError, void>> => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn()
    const resolvePendingCorrelation = { execute } as unknown as ResolvePendingCorrelationUseCase

    await new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-bad-header-1',
      name: 'ses.notification.correlation.pending',
      payload: { sesMessageId: 'ses-msg-1', status: 'delivered' },
      headers: { attempt: 'not-a-number', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
        message: expect.objectContaining({
          payload: {
            rawBody: { sesMessageId: 'ses-msg-1', status: 'delivered' },
            reason: 'invalid attempt/nextAttemptAt headers'
          }
        })
      })
    )
  })

  it('routes to the DLQ when the attempt header is absent altogether', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput): Promise<Either<BaseError, void>> => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn()
    const resolvePendingCorrelation = { execute } as unknown as ResolvePendingCorrelationUseCase

    await new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-missing-attempt',
      name: 'ses.notification.correlation.pending',
      payload: { sesMessageId: 'ses-msg-1', status: 'delivered' },
      headers: { nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
        message: expect.objectContaining({
          payload: {
            rawBody: { sesMessageId: 'ses-msg-1', status: 'delivered' },
            reason: 'invalid attempt/nextAttemptAt headers'
          }
        })
      })
    )
  })

  it('routes to the DLQ when the attempt header is not a positive integer', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput): Promise<Either<BaseError, void>> => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn()
    const resolvePendingCorrelation = { execute } as unknown as ResolvePendingCorrelationUseCase

    await new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-negative-attempt',
      name: 'ses.notification.correlation.pending',
      payload: { sesMessageId: 'ses-msg-1', status: 'delivered' },
      headers: { attempt: '-1', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
        message: expect.objectContaining({
          payload: {
            rawBody: { sesMessageId: 'ses-msg-1', status: 'delivered' },
            reason: 'invalid attempt/nextAttemptAt headers'
          }
        })
      })
    )
  })

  it('routes to the DLQ when the nextAttemptAt header is absent altogether', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput): Promise<Either<BaseError, void>> => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn()
    const resolvePendingCorrelation = { execute } as unknown as ResolvePendingCorrelationUseCase

    await new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-missing-next-attempt-at',
      name: 'ses.notification.correlation.pending',
      payload: { sesMessageId: 'ses-msg-1', status: 'delivered' },
      headers: { attempt: '1' }
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
        message: expect.objectContaining({
          payload: {
            rawBody: { sesMessageId: 'ses-msg-1', status: 'delivered' },
            reason: 'invalid attempt/nextAttemptAt headers'
          }
        })
      })
    )
  })

  it('routes to the DLQ when the nextAttemptAt header is not a parseable date', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput): Promise<Either<BaseError, void>> => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn()
    const resolvePendingCorrelation = { execute } as unknown as ResolvePendingCorrelationUseCase

    await new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-bad-header-2',
      name: 'ses.notification.correlation.pending',
      payload: { sesMessageId: 'ses-msg-1', status: 'delivered' },
      headers: { attempt: '1', nextAttemptAt: 'not-a-date' }
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC, key: expect.any(String) })
    )
  })

  it('returns a failure when the use case fails, so KafkaMessageConsumer does not commit the offset', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput): Promise<Either<BaseError, void>> => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const producer = { publish: vi.fn() } as unknown as MessageProducerPort
    const execute = vi.fn().mockResolvedValue(failure({ name: 'MessagePublishError', message: 'kafka down' }))
    const resolvePendingCorrelation = { execute } as unknown as ResolvePendingCorrelationUseCase

    await new SesNotificationCorrelationRetryConsumer(fakeConsumer, producer, resolvePendingCorrelation).onModuleInit()

    const messagePromise = onMessage({
      eventId: 'evt-7',
      name: 'ses.notification.correlation.pending',
      payload: { sesMessageId: 'ses-msg-1', status: 'delivered' },
      headers: { attempt: '1', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    await vi.advanceTimersByTimeAsync(10_000)
    const result = await messagePromise

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('kafka down')
    }
  })
})
