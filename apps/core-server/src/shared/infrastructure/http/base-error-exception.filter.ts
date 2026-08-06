import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common'
import { BaseError, StatusError } from '@ruguin/shared-domain'
import { type FastifyReply } from 'fastify'

const STATUS_ERROR_TO_HTTP: Record<StatusError, number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500
}

/*
 * BaseError needs its own branch because it deliberately does not extend Error, so the `instanceof
 * Error` check alone would miss every wrapped domain cause in this codebase and print
 * "[object Object]". The fallback is String(), never JSON.stringify(): a cause is frequently a
 * driver error object, and stringify throws on a circular one — inside an exception filter that
 * would replace the failure being reported with a second, worse one.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof BaseError) return `${cause.name}: ${cause.message}`
  if (cause instanceof Error) return cause.message
  return String(cause)
}

@Catch(BaseError)
export class BaseErrorExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(BaseErrorExceptionFilter.name)

  public catch(exception: BaseError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>()
    const httpStatus = STATUS_ERROR_TO_HTTP[exception.status]

    /*
     * Being global, this filter pre-empts Nest's ExceptionsHandler — nothing else ever sees the
     * exception, so whatever is not logged here is lost. `error` holds the wrapped cause that the
     * response body deliberately omits, and on a 5xx it is the only record of why the app failed.
     * 4xx stays silent on purpose, same reasoning as createPinoHttpOptions' customLogLevel: it is
     * the client's fault and an anonymous caller could otherwise flood the logs at will.
     */
    if (httpStatus >= 500) {
      const cause = exception.error
      const stack = cause instanceof Error ? cause.stack : undefined
      this.logger.error(
        cause === undefined
          ? `${exception.name}: ${exception.message}`
          : `${exception.name}: ${exception.message} — cause: ${describeCause(cause)}`,
        stack
      )
    }

    reply.status(httpStatus).send({ error: exception.name, message: exception.message })
  }
}
