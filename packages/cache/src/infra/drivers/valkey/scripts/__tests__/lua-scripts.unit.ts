import { describe, expect, it } from 'vitest'

import {
  BUMP_NAMESPACE_VERSION_SCRIPT,
  EXTEND_LOCK_SCRIPT,
  GET_WITH_NAMESPACE_VERSION_SCRIPT,
  type LuaScript,
  RELEASE_LOCK_SCRIPT
} from '../lua-scripts'

const highestKeyIndex = (input: { source: string }): number => {
  const matches: readonly string[] = input.source.match(/KEYS\[\d+\]/gu) ?? []

  let highest = 0
  for (const match of matches) highest = Math.max(highest, Number(match.slice(5, -1)))

  return highest
}

const scripts: ReadonlyArray<readonly [string, LuaScript]> = [
  ['release lock', RELEASE_LOCK_SCRIPT],
  ['extend lock', EXTEND_LOCK_SCRIPT],
  ['get with namespace version', GET_WITH_NAMESPACE_VERSION_SCRIPT],
  ['bump namespace version', BUMP_NAMESPACE_VERSION_SCRIPT]
]

describe('lua scripts', () => {
  /*
   * numberOfKeys is passed to EVAL as the boundary between KEYS and ARGV. Getting it wrong does
   * not fail loudly — the server simply reads the caller's first ARGV as a key — so pinning it to
   * what the source actually references is the cheap guard against a silent mis-slot.
   */
  it.each(scripts)('declares the key count %s actually references', (_name, script) => {
    expect(script.numberOfKeys).toBe(highestKeyIndex({ source: script.source }))
  })

  it('compares the token before releasing, instead of deleting blindly', () => {
    expect(RELEASE_LOCK_SCRIPT.source).toContain("redis.call('GET', KEYS[1]) == ARGV[1]")
    expect(RELEASE_LOCK_SCRIPT.source).toContain("redis.call('DEL', KEYS[1])")
  })

  it('compares the token before extending, for the same reason', () => {
    expect(EXTEND_LOCK_SCRIPT.source).toContain("redis.call('GET', KEYS[1]) == ARGV[1]")
    expect(EXTEND_LOCK_SCRIPT.source).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[2])")
  })

  it('treats an absent namespace version as 1 on both read and bump', () => {
    expect(GET_WITH_NAMESPACE_VERSION_SCRIPT.source).toContain("or '1'")
    expect(BUMP_NAMESPACE_VERSION_SCRIPT.source).toContain("or '1'")
  })
})
