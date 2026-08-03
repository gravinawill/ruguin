import { serverENV } from '@ruguin/env'
import { type Options } from 'pino-http'

export function createPinoHttpOptions(): Options {
  const isProduction = serverENV.ENVIRONMENT === 'production'

  return {
    level: isProduction ? 'info' : 'debug',
    ...(!isProduction && { transport: { target: 'pino-pretty' } }),
    redact: ['req.headers.authorization'],
    /*
     * pino-http's default escalates any request carrying an error to `error`, so a rejected Basic
     * Auth attempt on /docs logs at ERROR — noise an anonymous client can generate at will. Client
     * errors are the client's fault, not an app fault: keep 4xx at `warn` and reserve `error` for
     * 5xx and for failures that never reached a status code.
     */
    customLogLevel: (_request, response, error) => {
      if (response.statusCode >= 500) return 'error'
      if (response.statusCode >= 400) return 'warn'
      return error === undefined ? 'info' : 'error'
    }
  }
}
