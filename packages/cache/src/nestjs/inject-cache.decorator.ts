import { Inject } from '@nestjs/common'

import { CACHE_PROVIDER } from './cache.tokens'

/*
 * Sugar for @Inject(CACHE_PROVIDER). It exists so the common case reads as a declaration rather
 * than as a token lookup; anyone wanting a narrower contract reaches for @Inject(GET_CACHE_PROVIDER)
 * and friends directly, which is the whole reason the granular tokens exist.
 */
export const InjectCache = (): ReturnType<typeof Inject> => Inject(CACHE_PROVIDER)
