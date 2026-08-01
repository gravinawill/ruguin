import { type Either } from '@ruguin/utils'

import { type CacheSerializationError } from '../../errors/index.ts'

export namespace SerializerStrategyDTO {
  export type SerializeInput<T> = Readonly<{ value: T }>
  export type SerializeOutput = Either<CacheSerializationError, Readonly<{ serialized: string }>>

  export type DeserializeInput = Readonly<{ raw: string }>
  export type DeserializeOutput<T> = Either<CacheSerializationError, Readonly<{ value: T }>>
}

export interface ISerializerStrategy {
  serialize<T>(input: SerializerStrategyDTO.SerializeInput<T>): SerializerStrategyDTO.SerializeOutput
  deserialize<T>(input: SerializerStrategyDTO.DeserializeInput): SerializerStrategyDTO.DeserializeOutput<T>
}
