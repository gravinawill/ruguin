import { type StatusError } from '../enums'

export abstract class BaseError {
  readonly error?: unknown
  readonly message: string
  abstract readonly name: string
  abstract readonly status: StatusError

  protected constructor(input: { message: string; error?: unknown }) {
    this.error = input.error
    this.message = input.message
  }
}
