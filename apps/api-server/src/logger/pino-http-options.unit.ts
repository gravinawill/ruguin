import { describe, expect, it } from 'vitest'

import { createPinoHttpOptions } from './pino-http-options.js'

describe('createPinoHttpOptions', () => {
  it('defaults to info level and pretty-prints outside production', () => {
    const options = createPinoHttpOptions({ NODE_ENV: 'development' })

    expect(options.level).toBe('info')
    expect(options.transport).toEqual({ target: 'pino-pretty' })
  })

  it('respects LOG_LEVEL and disables pretty-print in production', () => {
    const options = createPinoHttpOptions({ NODE_ENV: 'production', LOG_LEVEL: 'warn' })

    expect(options.level).toBe('warn')
    expect(options.transport).toBeUndefined()
  })

  it('redacts the authorization header', () => {
    const options = createPinoHttpOptions({})

    expect(options.redact).toContain('req.headers.authorization')
  })
})
