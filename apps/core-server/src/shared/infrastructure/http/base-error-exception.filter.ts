import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common'
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

@Catch(BaseError)
export class BaseErrorExceptionFilter implements ExceptionFilter {
  public catch(exception: BaseError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>()
    const httpStatus = STATUS_ERROR_TO_HTTP[exception.status]

    reply.status(httpStatus).send({ error: exception.name, message: exception.message })
  }
}
