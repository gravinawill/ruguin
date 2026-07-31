export type LuaScript = Readonly<{ numberOfKeys: number; source: string }>

/*
 * Compare-and-swap on the token, never a bare DEL. A process whose lock already expired would
 * otherwise delete the lock a *different* process acquired after it, which is exactly the
 * mutual exclusion the lock exists to provide being handed to two owners at once.
 */
export const RELEASE_LOCK_SCRIPT: LuaScript = {
  numberOfKeys: 1,
  source: `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`
}

// Same compare-and-swap: extending a lock you no longer own is the same bug as releasing it.
export const EXTEND_LOCK_SCRIPT: LuaScript = {
  numberOfKeys: 1,
  source: `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`
}

/*
 * Strong read in a single round trip. A pipeline cannot express this: the second command's key
 * depends on the *value* the first returns, and a pipeline carries no data dependency between
 * its commands. Lua is what collapses "resolve the version, then read under it" into one hop.
 *
 * The reply is a table so the caller can refresh its local memo with the version it just read.
 * A missing value shortens the table to one element instead of appearing as nil, because a nil
 * inside a Lua table truncates it — `{ version, nil }` and `{ version }` are the same value,
 * and the caller would have no way to tell "no such key" from a malformed reply.
 */
export const GET_WITH_NAMESPACE_VERSION_SCRIPT: LuaScript = {
  numberOfKeys: 1,
  source: `
local version = redis.call('GET', KEYS[1]) or '1'
local value = redis.call('GET', ARGV[1] .. ':v' .. version .. ':' .. ARGV[2])
if value == false then return { version } end
return { version, value }
`
}

/*
 * An absent version key means version 1, so a plain INCR would be a no-op invalidation: it
 * returns 1 on a missing key, leaving readers on the very version the caller asked to retire.
 * Reading the current value and writing current + 1 keeps the "absent means 1" convention that
 * the read script above encodes, and stays atomic.
 */
export const BUMP_NAMESPACE_VERSION_SCRIPT: LuaScript = {
  numberOfKeys: 1,
  source: `
local current = tonumber(redis.call('GET', KEYS[1]) or '1')
local bumped = current + 1
redis.call('SET', KEYS[1], bumped)
return bumped
`
}
