import { type ArgumentsHost } from '@nestjs/common'
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
})
