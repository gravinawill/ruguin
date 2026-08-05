import { describe, expect, it } from 'vitest'

import { DATABASE_SCHEMA, withSchema } from '../database-schema.ts'

describe('withSchema', () => {
  it('sets the schema param on a connection string that has none', () => {
    const result = withSchema('postgresql://user:pass@localhost:5432/db')

    expect(new URL(result).searchParams.get('schema')).toBe(DATABASE_SCHEMA)
  })

  it('replaces, not appends, an existing schema param', () => {
    const result = withSchema('postgresql://user:pass@localhost:5432/db?schema=public')

    const url = new URL(result)
    expect(url.searchParams.getAll('schema')).toEqual([DATABASE_SCHEMA])
  })

  it("preserves the connection string's other query params", () => {
    const result = withSchema('postgresql://user:pass@localhost:5432/db?connection_limit=5')

    expect(new URL(result).searchParams.get('connection_limit')).toBe('5')
  })
})
