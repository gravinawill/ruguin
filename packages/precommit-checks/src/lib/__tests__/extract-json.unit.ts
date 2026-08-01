import { describe, expect, it } from 'vitest'

import { extractJson } from '../extract-json'

describe('extractJson', () => {
  it('parses a clean JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips leading spinner/info noise before an object', () => {
    const noisy =
      '[INFO] Analyzing complexity: /repo\n... Calculating complexity...   {"files":[],"summary":{"total":0}}'
    expect(extractJson(noisy)).toEqual({ files: [], summary: { total: 0 } })
  })

  it('strips leading noise before an array', () => {
    const noisy = 'Scanning...\n[1,2,3]'
    expect(extractJson(noisy)).toEqual([1, 2, 3])
  })

  it('returns null when there is no JSON in the output', () => {
    expect(extractJson('No secrets detected.')).toBeNull()
  })

  it('returns null when the JSON-looking fragment is malformed', () => {
    expect(extractJson('prefix {not: valid json}')).toBeNull()
  })
})
