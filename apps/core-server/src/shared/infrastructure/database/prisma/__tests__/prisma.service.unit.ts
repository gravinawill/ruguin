import { describe, expect, it, vi } from 'vitest'

import { PrismaService, resolveSchemaFrom } from '../prisma.service'

const connectionString = 'postgresql://u:p@localhost:5432/ruguin?schema=core_server'

describe('PrismaService', () => {
  /*
   * The Postgres adapter (and the pg Pool it wraps) only opens a socket lazily, on the first
   * query — asserted here because CLAUDE.md commits to that contract explicitly ("PrismaService
   * não chama $connect no boot"): the health check, not module construction, owns reporting a
   * database being unreachable.
   */
  it('constructs without opening a database connection', () => {
    expect(() => new PrismaService(connectionString)).not.toThrow()
  })

  it('disconnects the underlying client when the module is destroyed', async () => {
    const service = new PrismaService(connectionString)
    const disconnect = vi.spyOn(service, '$disconnect').mockResolvedValue(undefined)

    await service.onModuleDestroy()

    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('exposes the schema declared in the connection string, for raw SQL that cannot inherit the adapter option', () => {
    const service = new PrismaService(connectionString)

    expect(service.schema).toBe('core_server')
  })

  it('falls back to the public schema when the connection string declares none', () => {
    const service = new PrismaService('postgresql://u:p@localhost:5432/ruguin')

    expect(service.schema).toBe('public')
  })
})

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
