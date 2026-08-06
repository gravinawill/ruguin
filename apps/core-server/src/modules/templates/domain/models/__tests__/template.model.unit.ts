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
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      text: 'Hi {{name}}',
      createdAt: new Date('2026-08-06T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('rejects an empty senderIdentityId', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: '',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      text: 'Hi {{name}}',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty subject', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: '',
      html: '<p>Hi {{name}}</p>',
      text: 'Hi {{name}}',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty html', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '',
      text: 'Hi {{name}}',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty text', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      text: '',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
