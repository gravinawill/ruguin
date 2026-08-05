import { type Either, failure, success } from '@ruguin/utils'

import { InvalidSentEmailCorrelationError } from '../errors/invalid-sent-email-correlation.error.ts'

export type CreateSentEmailCorrelationInput = Readonly<{ sesMessageId: string; emailId: string }>

export class SentEmailCorrelation {
  public readonly sesMessageId: string
  public readonly emailId: string

  private constructor(input: { sesMessageId: string; emailId: string }) {
    this.sesMessageId = input.sesMessageId
    this.emailId = input.emailId
    Object.freeze(this)
  }

  public static create(
    input: CreateSentEmailCorrelationInput
  ): Either<InvalidSentEmailCorrelationError, SentEmailCorrelation> {
    const sesMessageId = input.sesMessageId.trim()

    if (sesMessageId.length === 0) {
      return failure(new InvalidSentEmailCorrelationError({ message: 'sesMessageId must not be empty' }))
    }

    const emailId = input.emailId.trim()

    if (emailId.length === 0) {
      return failure(new InvalidSentEmailCorrelationError({ message: 'emailId must not be empty' }))
    }

    return success(new SentEmailCorrelation({ sesMessageId, emailId }))
  }
}
