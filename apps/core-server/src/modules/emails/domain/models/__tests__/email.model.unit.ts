import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Email } from '../email.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Email.create', () => {
  it('builds an Email from valid input', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date('2026-08-06T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('rejects an empty templateId', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: '',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty senderIdentityId', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: '',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty "from"', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: '',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty "to"', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: '',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty subject', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: '',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty html', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty text', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: '',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
