import {
  type Attributes,
  type AttributeValue,
  type Span,
  type SpanContext,
  type SpanStatus,
  SpanStatusCode,
  type Tracer
} from '@opentelemetry/api'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import { CacheConnectionError, CacheDriver, type GetCacheProviderDTO } from '../../../domain/index.ts'
import { NoopCacheDriver } from '../../drivers/noop/noop-cache.driver.ts'
import { ObservableCacheProvider } from '../observable-cache.provider.ts'

type Recorded = { attributes: Attributes; name: string; status: SpanStatusCode | null; wasEnded: boolean }

/*
 * A recording stand-in rather than the real SDK: the decorator's contract is which span it opens
 * and what it puts on that span, and asserting it against a live exporter would test the exporter.
 */
class FakeSpan implements Span {
  private readonly recorded: Recorded

  constructor(input: { recorded: Recorded }) {
    this.recorded = input.recorded
  }

  public addEvent(): this {
    return this
  }

  public addLink(): this {
    return this
  }

  public addLinks(): this {
    return this
  }

  public end(): void {
    this.recorded.wasEnded = true
  }

  public isRecording(): boolean {
    return true
  }

  public recordException(): void {
    // Not exercised: the decorator reports failures through setStatus, not exceptions.
  }

  public setAttribute(key: string, value: AttributeValue): this {
    this.recorded.attributes[key] = value

    return this
  }

  public setAttributes(attributes: Attributes): this {
    Object.assign(this.recorded.attributes, attributes)

    return this
  }

  public setStatus(status: SpanStatus): this {
    this.recorded.status = status.code

    return this
  }

  public spanContext(): SpanContext {
    return { spanId: '0'.repeat(16), traceFlags: 0, traceId: '0'.repeat(32) }
  }

  public updateName(): this {
    return this
  }
}

const recordingTracer = (input: { spans: Recorded[] }): Tracer => ({
  startActiveSpan: () => {
    throw new Error('ObservableCacheProvider opens leaf spans with startSpan')
  },
  startSpan: (name, options): Span => {
    const recorded: Recorded = { attributes: { ...options?.attributes }, name, status: null, wasEnded: false }
    input.spans.push(recorded)

    return new FakeSpan({ recorded })
  }
})

class HittingDriver extends NoopCacheDriver {
  public override get<T>(): GetCacheProviderDTO.Output<T> {
    return Promise.resolve(success({ found: true, value: null as T | null }))
  }
}

class BrokenDriver extends NoopCacheDriver {
  public override get<T>(): GetCacheProviderDTO.Output<T> {
    return Promise.resolve(failure(new CacheConnectionError({ operation: 'get' })))
  }
}

describe('ObservableCacheProvider', () => {
  it('opens one span per operation, tagged with driver, operation and namespace', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.VALKEY,
      inner: new HittingDriver(),
      tracer: recordingTracer({ spans })
    })

    await provider.get({ key: 'a', namespace: 'user' })

    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('cache.get')
    expect(spans[0]?.attributes).toMatchObject({
      'cache.driver': 'valkey',
      'cache.namespace': 'user',
      'cache.operation': 'get'
    })
  })

  // Hit rate becomes measurable without a second instrumentation pass over every call site.
  it('records whether the read hit', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.VALKEY,
      inner: new HittingDriver(),
      tracer: recordingTracer({ spans })
    })

    await provider.get({ key: 'a', namespace: 'user' })

    expect(spans[0]?.attributes['cache.hit']).toBe(true)
    expect(spans[0]?.attributes['cache.outcome']).toBe('ok')
  })

  it('marks the span as an error when the driver fails', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.VALKEY,
      inner: new BrokenDriver(),
      tracer: recordingTracer({ spans })
    })

    await provider.get({ key: 'a', namespace: 'user' })

    expect(spans[0]?.status).toBe(SpanStatusCode.ERROR)
    expect(spans[0]?.attributes['cache.outcome']).toBe('error')
  })

  // The decorator must be transparent: same Either in, same Either out, span closed either way.
  it('hands the driver result back untouched', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.VALKEY,
      inner: new BrokenDriver(),
      tracer: recordingTracer({ spans })
    })

    const result = await provider.get({ key: 'a', namespace: 'user' })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.name).toBe('CacheConnectionError')
    expect(spans[0]?.wasEnded).toBe(true)
  })

  it('omits the namespace attribute on operations that have none', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.NOOP,
      inner: new NoopCacheDriver(),
      tracer: recordingTracer({ spans })
    })

    await provider.connect()

    expect(spans[0]?.name).toBe('cache.connect')
    expect(spans[0]?.attributes['cache.namespace']).toBeUndefined()
  })
})
