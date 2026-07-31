import { failure, success } from '@ruguin/utils'

import { CacheSerializationError, type ISerializerStrategy, type SerializerStrategyDTO } from '../../domain'

export class JsonSerializerStrategy implements ISerializerStrategy {
  public serialize<T>(input: SerializerStrategyDTO.SerializeInput<T>): SerializerStrategyDTO.SerializeOutput {
    try {
      /*
       * The lib types say `string`, but JSON.stringify really returns undefined for undefined,
       * functions and symbols. Without the widening cast the guard below is statically dead
       * code and `no-unnecessary-condition` rejects it.
       */
      const serialized = JSON.stringify(input.value) as string | undefined

      if (serialized === undefined) {
        return failure(
          new CacheSerializationError({
            operation: 'serialize',
            error: new Error('value is not representable in JSON')
          })
        )
      }

      return success({ serialized })
    } catch (error: unknown) {
      return failure(new CacheSerializationError({ operation: 'serialize', error }))
    }
  }

  public deserialize<T>(input: SerializerStrategyDTO.DeserializeInput): SerializerStrategyDTO.DeserializeOutput<T> {
    try {
      const value: T = JSON.parse(input.raw) as T

      return success({ value })
    } catch (error: unknown) {
      return failure(new CacheSerializationError({ operation: 'deserialize', error }))
    }
  }
}
