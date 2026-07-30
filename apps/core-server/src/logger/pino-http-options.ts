import type { Options } from 'pino-http'

export function createPinoHttpOptions(environment: NodeJS.ProcessEnv): Options {
  const isProduction = environment.NODE_ENV === 'production'

  return {
    level: environment.LOG_LEVEL ?? 'info',
    ...(!isProduction && { transport: { target: 'pino-pretty' } }),
    redact: ['req.headers.authorization']
  }
}
