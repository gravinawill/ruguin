import { NodeSDK } from '@opentelemetry/sdk-node'
import { describe, expect, it } from 'vitest'

import { createTracingSdk, resolveOtlpEndpoint } from '../create-tracing-sdk'

describe('resolveOtlpEndpoint', () => {
  it('defaults to the local OTel Collector HTTP endpoint', () => {
    expect(resolveOtlpEndpoint({})).toBe('http://localhost:4318/v1/traces')
  })

  it('respects OTEL_EXPORTER_OTLP_ENDPOINT when set', () => {
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fixture asserts an operator-supplied endpoint override, not live traffic
    const environment = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' } as NodeJS.ProcessEnv

    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fixture asserts an operator-supplied endpoint override, not live traffic
    expect(resolveOtlpEndpoint(environment)).toBe('http://collector:4318/v1/traces')
  })
})

describe('createTracingSdk', () => {
  it('returns a NodeSDK instance', () => {
    const sdk = createTracingSdk({})

    expect(sdk).toBeInstanceOf(NodeSDK)
  })
})
