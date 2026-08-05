import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type AuthenticatedTenant } from '../../../../api-keys/infrastructure/http/authenticated-tenant'
import { type SenderIdentityService } from '../../../application/services/sender-identity.service'
import { InvalidRegisterSenderIdentityRequestError } from '../../../domain/errors/invalid-register-sender-identity-request.error'
import { InvalidSenderIdentityError } from '../../../domain/errors/invalid-sender-identity.error'
import { SenderIdentity } from '../../../domain/models/sender-identity.model'
import { SenderIdentityController } from '../sender-identity.controller'

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity() {
  const result = SenderIdentity.create({
    id: validId(),
    projectId: 'project-1',
    name: 'Will Gravina',
    email: 'will@gravina.dev',
    verifiedAt: null,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

const tenant: AuthenticatedTenant = { projectId: 'project-1', organizationId: 'org-1' }

describe('SenderIdentityController#register', () => {
  it('returns the created resource, resolved domain included, on success', async () => {
    const senderIdentity = buildSenderIdentity()
    const registerMock = vi.fn().mockResolvedValue(success(senderIdentity))
    const service = { register: registerMock } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    const response = await controller.register({ name: 'Will Gravina', email: 'will@gravina.dev' }, tenant)

    expect(response).toMatchObject({
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      domain: 'gravina.dev',
      verifiedAt: null
    })
    expect(registerMock).toHaveBeenCalledWith({
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      projectId: 'project-1'
    })
  })

  it('throws InvalidRegisterSenderIdentityRequestError for a malformed body, without calling the service', async () => {
    const registerMock = vi.fn()
    const service = { register: registerMock } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    await expect(controller.register({ name: '' }, tenant)).rejects.toBeInstanceOf(
      InvalidRegisterSenderIdentityRequestError
    )
    expect(registerMock).not.toHaveBeenCalled()
  })

  it('throws whatever BaseError the service returns as a failure', async () => {
    const service = {
      register: vi.fn().mockResolvedValue(failure(new InvalidSenderIdentityError({ reason: 'name is empty' })))
    } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    await expect(
      controller.register({ name: 'Will Gravina', email: 'will@gravina.dev' }, tenant)
    ).rejects.toBeInstanceOf(InvalidSenderIdentityError)
  })
})

describe('SenderIdentityController#list', () => {
  it('returns every sender identity for the authenticated project', async () => {
    const senderIdentity = buildSenderIdentity()
    const listMock = vi.fn().mockResolvedValue(success([senderIdentity]))
    const service = { list: listMock } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    const response = await controller.list(tenant)

    expect(response).toHaveLength(1)
    expect(listMock).toHaveBeenCalledWith({ projectId: 'project-1' })
  })

  it('throws whatever BaseError the service returns as a failure', async () => {
    const service = {
      list: vi.fn().mockResolvedValue(failure(new InvalidSenderIdentityError({ reason: 'boom' })))
    } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    await expect(controller.list(tenant)).rejects.toBeInstanceOf(InvalidSenderIdentityError)
  })
})
