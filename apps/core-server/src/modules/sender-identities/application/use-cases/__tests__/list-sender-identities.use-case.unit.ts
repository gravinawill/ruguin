import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type SenderIdentityRepository } from '../../../domain/contracts/repositories/sender-identity.repository'
import { FindSenderIdentityError } from '../../../domain/errors/find-sender-identity.error'
import { ListSenderIdentitiesUseCase } from '../list-sender-identities.use-case'

describe('ListSenderIdentitiesUseCase', () => {
  it('returns the sender identities the repository finds for the project', async () => {
    const findManyByProjectId = vi.fn().mockResolvedValue(success({ senderIdentities: [] }))
    const repository = { findManyByProjectId } as unknown as SenderIdentityRepository
    const useCase = new ListSenderIdentitiesUseCase(repository)

    const result = await useCase.execute({ projectId: 'project-1' })

    expect(result.isSuccess()).toBe(true)
    expect(findManyByProjectId).toHaveBeenCalledWith({ projectId: 'project-1' })
  })

  it('propagates a repository failure', async () => {
    const repository = {
      findManyByProjectId: vi.fn().mockResolvedValue(failure(new FindSenderIdentityError({})))
    } as unknown as SenderIdentityRepository
    const useCase = new ListSenderIdentitiesUseCase(repository)

    const result = await useCase.execute({ projectId: 'project-1' })

    expect(result.isFailure()).toBe(true)
  })
})
