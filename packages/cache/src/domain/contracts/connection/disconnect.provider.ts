import { type Either } from '@ruguin/utils'

import { type CacheConnectionError } from '../../errors'

export namespace DisconnectProviderDTO {
  export type OutputError = Readonly<CacheConnectionError>
  export type OutputSuccess = Readonly<{ disconnected: true }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IDisconnectProvider {
  disconnect(): DisconnectProviderDTO.Output
}
