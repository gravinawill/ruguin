import { serverENV } from '@ruguin/env'
import { type Options } from 'pino-http'

export function createPinoHttpOptions(): Options {
  const isProduction = serverENV.ENVIRONMENT === 'production'

  return {
    level: isProduction ? 'info' : 'debug',
    ...(!isProduction && { transport: { target: 'pino-pretty' } }),
    redact: ['req.headers.authorization', 'req.headers.cookie']
  }
}
