import { type Either } from '@ruguin/utils'

import { type CacheConnectionError, type CacheTimeoutError } from '../../errors'

export namespace ConnectProviderDTO {
  export type OutputError = Readonly<CacheConnectionError | CacheTimeoutError>
  export type OutputSuccess = Readonly<{ connected: true }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IConnectProvider {
  connect(): ConnectProviderDTO.Output
}
