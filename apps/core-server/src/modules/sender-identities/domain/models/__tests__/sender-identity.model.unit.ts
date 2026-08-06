import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { SenderIdentity } from '../sender-identity.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('SenderIdentity.create', () => {
  it('builds an unverified SenderIdentity from valid input', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      verifiedAt: null,
      createdAt: new Date('2026-08-05T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.isVerified()).toBe(false)
      expect(result.value.domain).toBe('gravina.dev')
    }
  })

  it('reports isVerified() true once verifiedAt is set', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      verifiedAt: new Date('2026-08-05T01:00:00Z'),
      createdAt: new Date('2026-08-05T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.isVerified()).toBe(true)
  })

  it('rejects an empty projectId', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: '',
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      verifiedAt: null,
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty name', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: 'project-1',
      name: '',
      email: 'will@gravina.dev',
      verifiedAt: null,
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('falls back to an empty domain when the email has no @ (create only checks email is non-empty, not well-formed — well-formedness is enforced at the DTO boundary, not here)', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Will Gravina',
      email: 'not-an-email',
      verifiedAt: null,
      createdAt: new Date()
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.domain).toBe('')
  })

  it('rejects an empty email', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Will Gravina',
      email: '',
      verifiedAt: null,
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
