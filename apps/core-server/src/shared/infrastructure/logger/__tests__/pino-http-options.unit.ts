import { type IncomingMessage, type ServerResponse } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

const stubResponse = (statusCode: number): ServerResponse => ({ statusCode }) as unknown as ServerResponse
const stubRequest = {} as IncomingMessage

describe('createPinoHttpOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('defaults to debug level and pretty-prints outside production', async () => {
    setEnvironment({ ENVIRONMENT: 'develop' })
    const { createPinoHttpOptions } = await import('../pino-http-options')

    const options = createPinoHttpOptions()

    expect(options.level).toBe('debug')
    expect(options.transport).toEqual({ target: 'pino-pretty' })
  })

  it('raises the level to info and disables pretty-print in production', async () => {
    setEnvironment({ ENVIRONMENT: 'production' })
    const { createPinoHttpOptions } = await import('../pino-http-options')

    const options = createPinoHttpOptions()

    expect(options.level).toBe('info')
    expect(options.transport).toBeUndefined()
  })

  it('redacts the authorization header', async () => {
    setEnvironment({ ENVIRONMENT: 'test' })
    const { createPinoHttpOptions } = await import('../pino-http-options')

    const options = createPinoHttpOptions()

    expect(options.redact).toContain('req.headers.authorization')
  })

  it('logs a 5xx response at error level even without an error object', async () => {
    setEnvironment({ ENVIRONMENT: 'test' })
    const { createPinoHttpOptions } = await import('../pino-http-options')
    const { customLogLevel } = createPinoHttpOptions()

    expect(customLogLevel?.(stubRequest, stubResponse(503), undefined)).toBe('error')
  })

  it('logs a 4xx response at warn level, treating client-caused errors as noise rather than app failures', async () => {
    setEnvironment({ ENVIRONMENT: 'test' })
    const { createPinoHttpOptions } = await import('../pino-http-options')
    const { customLogLevel } = createPinoHttpOptions()

    expect(customLogLevel?.(stubRequest, stubResponse(401), new Error('missing credentials'))).toBe('warn')
  })

  it('logs a healthy response at info level when no error occurred', async () => {
    setEnvironment({ ENVIRONMENT: 'test' })
    const { createPinoHttpOptions } = await import('../pino-http-options')
    const { customLogLevel } = createPinoHttpOptions()

    expect(customLogLevel?.(stubRequest, stubResponse(200), undefined)).toBe('info')
  })

  it('logs at error level when an error occurs before a status code is ever set', async () => {
    setEnvironment({ ENVIRONMENT: 'test' })
    const { createPinoHttpOptions } = await import('../pino-http-options')
    const { customLogLevel } = createPinoHttpOptions()

    expect(customLogLevel?.(stubRequest, stubResponse(200), new Error('connection reset'))).toBe('error')
  })
})
