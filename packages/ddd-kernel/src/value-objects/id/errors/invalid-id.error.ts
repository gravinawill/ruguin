import { StatusError } from '../../../enums/index.ts'
import { BaseError } from '../../../errors/index.ts'

type InvalidIDErrorInput = { id: string; modelName: string } | { id: string; valueObjectName: string }

export class InvalidIDError extends BaseError {
  readonly name = 'InvalidIDError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: InvalidIDErrorInput) {
    const owner = 'modelName' in input ? input.modelName : input.valueObjectName

    super({ message: `Invalid ID "${input.id}" for "${owner}"` })
  }
}
