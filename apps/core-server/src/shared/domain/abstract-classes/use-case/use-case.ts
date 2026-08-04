import { performance } from 'node:perf_hooks'

import { type Either } from '@ruguin/utils'

import { type LoggerPort } from '../../contracts/logger.contract'

export abstract class UseCase<Parameters, ResultFailure, ResultSuccess> {
  constructor(public readonly logger: LoggerPort) {}

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && 'errorMessage' in error) {
      const message: unknown = error.errorMessage
      if (typeof message === 'string') return message
    }
    return 'An unexpected error occurred'
  }

  public async execute(input: Parameters): Promise<Either<ResultFailure, ResultSuccess>> {
    const startTime: number = performance.now()
    try {
      const response: Either<ResultFailure, ResultSuccess> = await this.performOperation(input)
      const slowOperationThresholdInMs = 1000
      const runtimeInMs: number = performance.now() - startTime
      if (runtimeInMs > slowOperationThresholdInMs) {
        this.logger.warn({
          message: `Slow operation in ${this.constructor.name} (${runtimeInMs}ms)`
        })
      }
      return response
    } catch (error: unknown) {
      const errorMessage: string = this.extractErrorMessage(error)
      const runtimeInMs: number = performance.now() - startTime
      this.logger.error({
        message: `Unexpected error in ${this.constructor.name} (${runtimeInMs}ms): ${errorMessage}`,
        value: error
      })
      throw error
    }
  }

  protected abstract performOperation(input: Parameters): Promise<Either<ResultFailure, ResultSuccess>>
}
