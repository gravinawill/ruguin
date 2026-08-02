import { describe, expect, it, vi } from 'vitest'

import { lazyEnvironment } from '../lazy-environment'

describe('lazyEnvironment', () => {
  it('does not build until a property is read', () => {
    const build = vi.fn(() => ({ VALUE: 'built' }))

    lazyEnvironment(build)

    expect(build).not.toHaveBeenCalled()
  })

  it('builds on first access and reuses the result afterwards', () => {
    const build = vi.fn(() => ({ VALUE: 'built' }))

    const environment = lazyEnvironment(build)

    expect(environment.VALUE).toBe('built')
    expect(environment.VALUE).toBe('built')
    expect(build).toHaveBeenCalledOnce()
  })

  it('surfaces the build failure at the point of access', () => {
    const environment = lazyEnvironment<{ VALUE: string }>(() => {
      throw new Error('Invalid environment variables')
    })

    expect(() => environment.VALUE).toThrow('Invalid environment variables')
  })

  it('supports spread and key enumeration', () => {
    const environment = lazyEnvironment(() => ({ FIRST: 1, SECOND: 2 }))

    expect({ ...environment }).toEqual({ FIRST: 1, SECOND: 2 })
    expect(Object.keys(environment)).toEqual(['FIRST', 'SECOND'])
  })

  it('answers the in operator', () => {
    const environment = lazyEnvironment(() => ({ PRESENT: 'yes' }))

    expect('PRESENT' in environment).toBe(true)
    expect('ABSENT' in environment).toBe(false)
  })
})
