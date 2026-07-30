import { StatusError } from '../../../enums'
import { BaseError } from '../../../errors'

type GenerateIDErrorInput = { modelName: string; error: Error } | { valueObjectName: string; error: Error }

export class GenerateIDError extends BaseError {
  readonly name = 'GenerateIDError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: GenerateIDErrorInput) {
    const owner = 'modelName' in input ? input.modelName : input.valueObjectName

    super({ message: `Failed to generate ID for "${owner}"`, error: input.error })
  }
}
