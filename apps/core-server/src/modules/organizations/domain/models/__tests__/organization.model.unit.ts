import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Organization } from '../organization.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Organization' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Organization.create', () => {
  it('builds an Organization from valid input', () => {
    const id = validId()
    const createdAt = new Date('2026-08-04T00:00:00Z')

    const result = Organization.create({ id, name: 'Acme', createdAt })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.id).toBe(id)
      expect(result.value.name).toBe('Acme')
      expect(result.value.createdAt).toBe(createdAt)
    }
  })

  it('rejects an empty name', () => {
    const result = Organization.create({ id: validId(), name: ' '.repeat(3), createdAt: new Date() })

    expect(result.isFailure()).toBe(true)
  })
})
