import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { ApiKey } from '../api-key.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'ApiKey' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('ApiKey.create', () => {
  it('builds an active ApiKey when revokedAt is null', () => {
    const result = ApiKey.create({
      id: validId(),
      projectId: 'project-1',
      hashedKey: 'a'.repeat(64),
      revokedAt: null,
      createdAt: new Date()
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.isRevoked()).toBe(false)
  })

  it('reports isRevoked() true when revokedAt is set', () => {
    const result = ApiKey.create({
      id: validId(),
      projectId: 'project-1',
      hashedKey: 'a'.repeat(64),
      revokedAt: new Date(),
      createdAt: new Date()
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.isRevoked()).toBe(true)
  })

  it('rejects an empty hashedKey', () => {
    const result = ApiKey.create({
      id: validId(),
      projectId: 'project-1',
      hashedKey: '',
      revokedAt: null,
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
