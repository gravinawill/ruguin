import { performance } from 'node:perf_hooks'

import { type Either, failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type LoggerPort } from '../../../contracts/logger.contract'
import { UseCase } from '../use-case'

type Parameters_ = { readonly value: number }

function createLogger(): { logger: LoggerPort; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  const error = vi.fn()
  return { error, logger: { error, warn }, warn }
}

class EchoUseCase extends UseCase<Parameters_, string, number> {
  protected performOperation(input: Parameters_): Promise<Either<string, number>> {
    return Promise.resolve(success(input.value))
  }
}

class RejectingUseCase extends UseCase<Parameters_, string, number> {
  protected performOperation(input: Parameters_): Promise<Either<string, number>> {
    return Promise.resolve(failure(`rejected ${input.value}`))
  }
}

class ThrowingUseCase extends UseCase<Parameters_, string, number> {
  constructor(
    logger: LoggerPort,
    private readonly toThrow: unknown
  ) {
    super(logger)
  }

  protected performOperation(): Promise<Either<string, number>> {
    throw this.toThrow
  }
}

describe('UseCase', () => {
  it('exposes the logger it was constructed with', () => {
    const { logger } = createLogger()

    expect(new EchoUseCase(logger).logger).toBe(logger)
  })

  it('returns the Success produced by performOperation', async () => {
    const { logger } = createLogger()

    const result = await new EchoUseCase(logger).execute({ value: 42 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value).toBe(42)
  })

  it('returns the Failure produced by performOperation without touching the logger', async () => {
    const { error, logger, warn } = createLogger()

    const result = await new RejectingUseCase(logger).execute({ value: 7 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe('rejected 7')
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('does not warn when the operation finishes under the slow threshold', async () => {
    const { logger, warn } = createLogger()
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(500)

    await new EchoUseCase(logger).execute({ value: 1 })

    expect(warn).not.toHaveBeenCalled()
  })

  it('warns with the subclass name and duration once the operation crosses the slow threshold', async () => {
    const { logger, warn } = createLogger()
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1500)

    await new EchoUseCase(logger).execute({ value: 1 })

    expect(warn).toHaveBeenCalledOnce()
    const [payload] = warn.mock.calls[0] as [{ message: string }]
    expect(payload.message).toContain('EchoUseCase')
    expect(payload.message).toContain('1500')
  })

  it('rethrows the original error unchanged after logging it', async () => {
    const { logger } = createLogger()
    const boom = new Error('disk full')

    await expect(new ThrowingUseCase(logger, boom).execute({ value: 1 })).rejects.toBe(boom)
  })

  const errorShapesAndExpectedMessages: ReadonlyArray<[name: string, thrown: unknown, expectedMessage: string]> = [
    ['an Error instance', new Error('disk full'), 'disk full'],
    ['a plain string', 'raw string failure', 'raw string failure'],
    ['an object exposing a string errorMessage', { errorMessage: 'queue unreachable' }, 'queue unreachable'],
    ['an object whose errorMessage is not a string', { errorMessage: 123 }, 'An unexpected error occurred'],
    ['an object without an errorMessage property', { code: 'ECONNRESET' }, 'An unexpected error occurred'],
    ['a bare primitive', 42, 'An unexpected error occurred'],
    ['null', null, 'An unexpected error occurred']
  ]

  it.each(errorShapesAndExpectedMessages)(
    'logs %s using the message it extracts, then rethrows it unchanged',
    async (_name, thrown, expectedMessage) => {
      const { error, logger } = createLogger()

      await expect(new ThrowingUseCase(logger, thrown).execute({ value: 1 })).rejects.toBe(thrown)

      const [payload] = error.mock.calls[0] as [{ message: string }]
      expect(payload.message).toContain(expectedMessage)
    }
  )
})
