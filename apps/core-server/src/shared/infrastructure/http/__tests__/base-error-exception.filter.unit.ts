import { type ArgumentsHost, Logger } from '@nestjs/common'
import { BaseError, StatusError } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { BaseErrorExceptionFilter } from '../base-error-exception.filter'

class FakeNotFoundError extends BaseError {
  readonly name = 'FakeNotFoundError'
  readonly status = StatusError.NOT_FOUND

  constructor() {
    super({ message: 'not found' })
  }
}

class FakeInternalError extends BaseError {
  readonly name = 'FakeInternalError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(error?: unknown) {
    super({ error, message: 'failed to persist' })
  }
}

/* Replaces the real transport so a deliberate 5xx does not print to the suite's output. */
function silenceLoggerError() {
  return vi.spyOn(Logger.prototype, 'error').mockImplementation(vi.fn())
}

function createHost() {
  const send = vi.fn()
  const status = vi.fn(() => ({ send }))
  const reply = { status }
  const host = {
    switchToHttp: () => ({ getResponse: () => reply })
  } as unknown as ArgumentsHost

  return { host, status, send }
}

describe('BaseErrorExceptionFilter', () => {
  it.each([
    [StatusError.INVALID_INPUT, 400],
    [StatusError.UNAUTHORIZED, 401],
    [StatusError.FORBIDDEN, 403],
    [StatusError.NOT_FOUND, 404],
    [StatusError.CONFLICT, 409],
    [StatusError.UNPROCESSABLE, 422],
    [StatusError.TOO_MANY_REQUESTS, 429],
    [StatusError.INTERNAL_ERROR, 500]
  ])('maps StatusError.%s to HTTP %i', (statusError, httpStatus) => {
    class TestError extends BaseError {
      readonly name = 'TestError'
      readonly status = statusError

      constructor() {
        super({ message: 'boom' })
      }
    }

    /* INTERNAL_ERROR is logged for real by the filter; silenced so the suite output stays clean. */
    silenceLoggerError()
    const filter = new BaseErrorExceptionFilter()
    const { host, status } = createHost()

    filter.catch(new TestError(), host)

    expect(status).toHaveBeenCalledWith(httpStatus)
  })

  it('sends the error name and message in the response body', () => {
    const filter = new BaseErrorExceptionFilter()
    const { host, send } = createHost()

    filter.catch(new FakeNotFoundError(), host)

    expect(send).toHaveBeenCalledWith({ error: 'FakeNotFoundError', message: 'not found' })
  })

  it('logs the wrapped cause of a 5xx-mapped error', () => {
    /*
     * A global filter pre-empts Nest's ExceptionsHandler, so this log is the only record a 5xx
     * ever leaves — the response body carries just the name and message on purpose.
     */
    const logError = silenceLoggerError()
    const filter = new BaseErrorExceptionFilter()
    const { host } = createHost()

    filter.catch(new FakeInternalError(new Error('connection terminated unexpectedly')), host)

    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      expect.stringMatching(/FakeInternalError.*connection terminated unexpectedly/),
      expect.stringContaining('connection terminated unexpectedly')
    )
  })

  it('does not log a 4xx-mapped error', () => {
    /* 4xx is the client's fault; logging it would let an anonymous caller flood the logs at will. */
    const logError = silenceLoggerError()
    const filter = new BaseErrorExceptionFilter()
    const { host } = createHost()

    filter.catch(new FakeNotFoundError(), host)

    expect(logError).not.toHaveBeenCalled()
  })

  it('still sends the minimal body, with no cause, for a 5xx-mapped error', () => {
    silenceLoggerError()
    const filter = new BaseErrorExceptionFilter()
    const { host, send } = createHost()

    filter.catch(new FakeInternalError(new Error('DATABASE_URL=postgres://user:secret@host')), host)

    expect(send).toHaveBeenCalledWith({ error: 'FakeInternalError', message: 'failed to persist' })
  })
})
