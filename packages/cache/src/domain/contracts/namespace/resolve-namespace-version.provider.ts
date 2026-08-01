import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums/index.ts'
import { type CacheOperationError } from '../../errors/index.ts'

export namespace ResolveNamespaceVersionProviderDTO {
  export type Input = Readonly<{ namespace: string; consistency?: CacheConsistency }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ version: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IResolveNamespaceVersionProvider {
  resolveNamespaceVersion(input: ResolveNamespaceVersionProviderDTO.Input): ResolveNamespaceVersionProviderDTO.Output
}
