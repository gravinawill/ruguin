import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors/index.ts'

export namespace InvalidateNamespaceProviderDTO {
  export type Input = Readonly<{ namespace: string }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ version: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IInvalidateNamespaceProvider {
  invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output
}
