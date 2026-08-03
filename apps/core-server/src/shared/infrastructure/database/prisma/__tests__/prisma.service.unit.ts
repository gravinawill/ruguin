import { describe, expect, it } from 'vitest'

import { resolveSchemaFrom } from '../prisma.service'

describe('resolveSchemaFrom', () => {
  it('extracts the schema declared in the connection string', () => {
    const result = resolveSchemaFrom('postgresql://u:p@localhost:5432/ruguin?schema=core_server')

    expect(result).toEqual({ schema: 'core_server' })
  })

  it('forces no schema when the URL declares none', () => {
    const result = resolveSchemaFrom('postgresql://u:p@localhost:5432/ruguin')

    expect(result).toEqual({})
  })

  it('treats an empty schema as absent instead of qualifying with an empty string', () => {
    const result = resolveSchemaFrom('postgresql://u:p@localhost:5432/ruguin?schema=')

    expect(result).toEqual({})
  })

  it('keeps the schema when the URL carries other parameters', () => {
    const result = resolveSchemaFrom(
      'postgresql://u:p@localhost:5432/ruguin?connection_limit=5&schema=core_server&sslmode=require'
    )

    expect(result).toEqual({ schema: 'core_server' })
  })
})
