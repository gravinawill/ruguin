import { type Either, failure, success } from '@ruguin/utils'
import { v7 as uuidv7 } from 'uuid'

import { GenerateIDError, InvalidIDError } from './errors'

export class ID {
  private static readonly UUID_V7_REGEX: RegExp =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  public static validate(
    input: { id: string; modelName: string } | { id: string; valueObjectName: string }
  ): Either<InvalidIDError, { idValidated: ID }> {
    const id: string = input.id.trim()

    if (!this.UUID_V7_REGEX.test(id)) {
      return failure(
        new InvalidIDError({
          id,
          ...('modelName' in input ? { modelName: input.modelName } : { valueObjectName: input.valueObjectName })
        })
      )
    }

    const idValidated: ID = new ID({ id })

    return success({ idValidated })
  }

  public static generate(
    input: { modelName: string } | { valueObjectName: string }
  ): Either<GenerateIDError, { idGenerated: ID }> {
    try {
      const idGenerated: ID = new ID({ id: uuidv7() })

      return success({ idGenerated })
    } catch (error: unknown) {
      const normalizedError: Error = error instanceof Error ? error : new Error(String(error))

      return failure(
        new GenerateIDError({
          ...('modelName' in input ? { modelName: input.modelName } : { valueObjectName: input.valueObjectName }),
          error: normalizedError
        })
      )
    }
  }

  public readonly value: string

  private constructor(input: { id: string }) {
    this.value = input.id.trim()
    Object.freeze(this)
  }

  public toString(): string {
    return this.value
  }

  public equals(input: { otherID: ID }): boolean {
    if (!(input.otherID instanceof ID)) return false
    return this.value.toLowerCase() === input.otherID.value.toLowerCase()
  }

  public getPartition(input: { totalShards: number }): number {
    const timestamp: number = Number.parseInt(this.value.replaceAll('-', '').slice(0, 12), 16)
    return timestamp % input.totalShards
  }
}
