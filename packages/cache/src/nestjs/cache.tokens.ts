/*
 * One token per contract, plus the composite. Every one of them resolves to the same instance —
 * the aliasing lives in cache.module.ts. The point is not to hand out different objects; it is to
 * let the injection point name exactly the slice it depends on, so a service that only reads a key
 * declares IGetCacheProvider and cannot quietly grow a call to invalidateNamespace.
 *
 * Symbols rather than strings: a string token collides silently across packages, and the collision
 * surfaces as the wrong provider being injected rather than as an error.
 */

/** `ICacheProvider` — the whole surface. Convenience, not the default choice. */
export const CACHE_PROVIDER = Symbol('CACHE_PROVIDER')

export const ACQUIRE_LOCK_PROVIDER = Symbol('ACQUIRE_LOCK_PROVIDER')
export const CONNECT_PROVIDER = Symbol('CONNECT_PROVIDER')
export const COUNT_SCORES_PROVIDER = Symbol('COUNT_SCORES_PROVIDER')
export const DECREMENT_COUNTER_PROVIDER = Symbol('DECREMENT_COUNTER_PROVIDER')
export const DELETE_CACHE_PROVIDER = Symbol('DELETE_CACHE_PROVIDER')
export const DISCONNECT_PROVIDER = Symbol('DISCONNECT_PROVIDER')
export const EXECUTE_WITH_LOCK_PROVIDER = Symbol('EXECUTE_WITH_LOCK_PROVIDER')
export const EXTEND_LOCK_PROVIDER = Symbol('EXTEND_LOCK_PROVIDER')
export const GET_CACHE_PROVIDER = Symbol('GET_CACHE_PROVIDER')
export const GET_COUNTER_PROVIDER = Symbol('GET_COUNTER_PROVIDER')
export const GET_OR_SET_CACHE_PROVIDER = Symbol('GET_OR_SET_CACHE_PROVIDER')
export const GET_RANK_PROVIDER = Symbol('GET_RANK_PROVIDER')
export const GET_SCORE_PROVIDER = Symbol('GET_SCORE_PROVIDER')
export const GET_TOP_SCORES_PROVIDER = Symbol('GET_TOP_SCORES_PROVIDER')
export const HEALTH_CHECK_PROVIDER = Symbol('HEALTH_CHECK_PROVIDER')
export const INCREMENT_COUNTER_PROVIDER = Symbol('INCREMENT_COUNTER_PROVIDER')
export const INCREMENT_SCORE_PROVIDER = Symbol('INCREMENT_SCORE_PROVIDER')
export const INVALIDATE_NAMESPACE_PROVIDER = Symbol('INVALIDATE_NAMESPACE_PROVIDER')
export const RELEASE_LOCK_PROVIDER = Symbol('RELEASE_LOCK_PROVIDER')
export const REMOVE_SCORE_PROVIDER = Symbol('REMOVE_SCORE_PROVIDER')
export const RESOLVE_NAMESPACE_VERSION_PROVIDER = Symbol('RESOLVE_NAMESPACE_VERSION_PROVIDER')
export const SET_CACHE_PROVIDER = Symbol('SET_CACHE_PROVIDER')
export const SET_IF_NOT_EXISTS_CACHE_PROVIDER = Symbol('SET_IF_NOT_EXISTS_CACHE_PROVIDER')
export const SET_SCORE_PROVIDER = Symbol('SET_SCORE_PROVIDER')

/** Internal wiring: the options `forRoot`/`forRootAsync` received, before defaults are applied. */
export const CACHE_MODULE_OPTIONS = Symbol('CACHE_MODULE_OPTIONS')

/*
 * Every token above except CACHE_PROVIDER and CACHE_MODULE_OPTIONS. The module aliases each one to
 * CACHE_PROVIDER; keeping the list here means a new contract is wired by adding a single line.
 */
export const CONTRACT_TOKENS: readonly symbol[] = [
  ACQUIRE_LOCK_PROVIDER,
  CONNECT_PROVIDER,
  COUNT_SCORES_PROVIDER,
  DECREMENT_COUNTER_PROVIDER,
  DELETE_CACHE_PROVIDER,
  DISCONNECT_PROVIDER,
  EXECUTE_WITH_LOCK_PROVIDER,
  EXTEND_LOCK_PROVIDER,
  GET_CACHE_PROVIDER,
  GET_COUNTER_PROVIDER,
  GET_OR_SET_CACHE_PROVIDER,
  GET_RANK_PROVIDER,
  GET_SCORE_PROVIDER,
  GET_TOP_SCORES_PROVIDER,
  HEALTH_CHECK_PROVIDER,
  INCREMENT_COUNTER_PROVIDER,
  INCREMENT_SCORE_PROVIDER,
  INVALIDATE_NAMESPACE_PROVIDER,
  RELEASE_LOCK_PROVIDER,
  REMOVE_SCORE_PROVIDER,
  RESOLVE_NAMESPACE_VERSION_PROVIDER,
  SET_CACHE_PROVIDER,
  SET_IF_NOT_EXISTS_CACHE_PROVIDER,
  SET_SCORE_PROVIDER
]
