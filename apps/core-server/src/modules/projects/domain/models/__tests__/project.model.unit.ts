import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Project } from '../project.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Project' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Project.create', () => {
  it('builds a Project from valid input', () => {
    const id = validId()
    const createdAt = new Date('2026-08-04T00:00:00Z')

    const result = Project.create({ id, organizationId: 'org-1', name: 'Prod', createdAt })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.organizationId).toBe('org-1')
      expect(result.value.name).toBe('Prod')
    }
  })

  it('rejects an empty name', () => {
    const result = Project.create({ id: validId(), organizationId: 'org-1', name: '', createdAt: new Date() })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty organizationId', () => {
    const result = Project.create({ id: validId(), organizationId: '', name: 'Prod', createdAt: new Date() })

    expect(result.isFailure()).toBe(true)
  })
})
