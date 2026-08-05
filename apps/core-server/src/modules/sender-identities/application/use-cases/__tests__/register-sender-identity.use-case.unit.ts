import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type SesIdentityProvider } from '../../../domain/contracts/providers/ses-identity.provider'
import { type SenderIdentityRepository } from '../../../domain/contracts/repositories/sender-identity.repository'
import { CreateSenderIdentityError } from '../../../domain/errors/create-sender-identity.error'
import { CreateSesIdentityError } from '../../../domain/errors/create-ses-identity.error'
import { InvalidSenderIdentityError } from '../../../domain/errors/invalid-sender-identity.error'
import { RegisterSenderIdentityUseCase } from '../register-sender-identity.use-case'

describe('RegisterSenderIdentityUseCase', () => {
  it('creates the row and registers it with SES', async () => {
    const create = vi.fn().mockImplementation(({ senderIdentity }) => success(senderIdentity))
    const repository = { create } as unknown as SenderIdentityRepository
    const createIdentity = vi.fn().mockResolvedValue(success(undefined))
    const sesIdentityProvider = { createIdentity } as unknown as SesIdentityProvider
    const useCase = new RegisterSenderIdentityUseCase(repository, sesIdentityProvider)

    const result = await useCase.execute({ projectId: 'project-1', name: 'Will Gravina', email: 'will@gravina.dev' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.email).toBe('will@gravina.dev')
      expect(result.value.verifiedAt).toBeNull()
    }
    expect(createIdentity).toHaveBeenCalledWith({ email: 'will@gravina.dev' })
  })

  it('fails with InvalidSenderIdentityError and never touches the repository or SES when name is empty', async () => {
    const create = vi.fn()
    const repository = { create } as unknown as SenderIdentityRepository
    const createIdentity = vi.fn()
    const sesIdentityProvider = { createIdentity } as unknown as SesIdentityProvider
    const useCase = new RegisterSenderIdentityUseCase(repository, sesIdentityProvider)

    const result = await useCase.execute({ projectId: 'project-1', name: '', email: 'will@gravina.dev' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(InvalidSenderIdentityError)
    expect(create).not.toHaveBeenCalled()
    expect(createIdentity).not.toHaveBeenCalled()
  })

  it('propagates a repository failure without calling SES', async () => {
    const repository = {
      create: vi.fn().mockResolvedValue(failure(new CreateSenderIdentityError({})))
    } as unknown as SenderIdentityRepository
    const createIdentity = vi.fn()
    const sesIdentityProvider = { createIdentity } as unknown as SesIdentityProvider
    const useCase = new RegisterSenderIdentityUseCase(repository, sesIdentityProvider)

    const result = await useCase.execute({ projectId: 'project-1', name: 'Will Gravina', email: 'will@gravina.dev' })

    expect(result.isFailure()).toBe(true)
    expect(createIdentity).not.toHaveBeenCalled()
  })

  it('propagates a SES failure after the row was already created', async () => {
    const create = vi.fn().mockImplementation(({ senderIdentity }) => success(senderIdentity))
    const repository = { create } as unknown as SenderIdentityRepository
    const createIdentity = vi.fn().mockResolvedValue(failure(new CreateSesIdentityError({})))
    const sesIdentityProvider = { createIdentity } as unknown as SesIdentityProvider
    const useCase = new RegisterSenderIdentityUseCase(repository, sesIdentityProvider)

    const result = await useCase.execute({ projectId: 'project-1', name: 'Will Gravina', email: 'will@gravina.dev' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(CreateSesIdentityError)
    expect(create).toHaveBeenCalledTimes(1)
  })
})
