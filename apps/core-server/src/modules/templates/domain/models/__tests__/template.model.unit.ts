import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Template } from '../template.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Template' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Template.create', () => {
  it('builds a Template from valid input', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      createdAt: new Date('2026-08-04T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('rejects an empty subject', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Welcome',
      subject: '',
      html: '<p>hi</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
