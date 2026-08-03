import { describe, expect, it } from 'vitest'

import { createPinoHttpOptions } from '../pino-http-options'

describe('createPinoHttpOptions', () => {
  it('uses debug level and pretty-prints outside production', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })

    expect(options.level).toBe('debug')
    expect(options.transport).toEqual({ target: 'pino-pretty' })
  })

  it('uses info level and drops pretty-print in production', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'production' })

    expect(options.level).toBe('info')
    expect(options.transport).toBeUndefined()
  })

  it('redacts the authorization header', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })

    expect(options.redact).toContain('req.headers.authorization')
  })

  it('keeps a 4xx at warn so an anonymous client cannot generate ERROR at will', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })
    const level = options.customLogLevel?.({} as never, { statusCode: 401 } as never, undefined)

    expect(level).toBe('warn')
  })

  it('raises a 5xx to error', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })
    const level = options.customLogLevel?.({} as never, { statusCode: 503 } as never, undefined)

    expect(level).toBe('error')
  })

  it('reports error when the request failed without reaching a status code', () => {
    const options = createPinoHttpOptions({ ENVIRONMENT: 'local' })
    const level = options.customLogLevel?.({} as never, { statusCode: 200 } as never, new Error('socket hang up'))

    expect(level).toBe('error')
  })
})
