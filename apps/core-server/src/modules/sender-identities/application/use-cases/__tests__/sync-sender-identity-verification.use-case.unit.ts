import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type SesIdentityProvider } from '../../../domain/contracts/providers/ses-identity.provider'
import { type SenderIdentityRepository } from '../../../domain/contracts/repositories/sender-identity.repository'
import { type SenderIdentityCacheProvider } from '../../../domain/contracts/sender-identity-cache.provider'
import { CheckSesIdentityError } from '../../../domain/errors/check-ses-identity.error'
import { FindSenderIdentityError } from '../../../domain/errors/find-sender-identity.error'
import { SenderIdentity } from '../../../domain/models/sender-identity.model'
import { SyncSenderIdentityVerificationUseCase } from '../sync-sender-identity-verification.use-case'

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity(email: string) {
  const result = SenderIdentity.create({
    id: validId(),
    projectId: 'project-1',
    name: 'Will Gravina',
    email,
    verifiedAt: null,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

describe('SyncSenderIdentityVerificationUseCase', () => {
  it('marks a sender identity verified and invalidates its cache entry once SES confirms', async () => {
    const senderIdentity = buildSenderIdentity('will@gravina.dev')
    const markVerified = vi.fn().mockResolvedValue(success(undefined))
    const repository = {
      findUnverified: vi.fn().mockResolvedValue(success({ senderIdentities: [senderIdentity] })),
      markVerified
    } as unknown as SenderIdentityRepository
    const sesIdentityProvider = {
      getVerificationStatus: vi.fn().mockResolvedValue(success({ verified: true }))
    } as unknown as SesIdentityProvider
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const cache = { invalidate } as unknown as SenderIdentityCacheProvider
    const useCase = new SyncSenderIdentityVerificationUseCase(repository, sesIdentityProvider, cache)

    await useCase.execute()

    expect(markVerified).toHaveBeenCalledWith({
      id: senderIdentity.id.toString(),
      verifiedAt: expect.any(Date)
    })
    expect(invalidate).toHaveBeenCalledWith({ senderIdentityId: senderIdentity.id.toString() })
  })

  it('does not mark verified or invalidate the cache when SES still reports unverified', async () => {
    const senderIdentity = buildSenderIdentity('will@gravina.dev')
    const markVerified = vi.fn()
    const repository = {
      findUnverified: vi.fn().mockResolvedValue(success({ senderIdentities: [senderIdentity] })),
      markVerified
    } as unknown as SenderIdentityRepository
    const sesIdentityProvider = {
      getVerificationStatus: vi.fn().mockResolvedValue(success({ verified: false }))
    } as unknown as SesIdentityProvider
    const invalidate = vi.fn()
    const cache = { invalidate } as unknown as SenderIdentityCacheProvider
    const useCase = new SyncSenderIdentityVerificationUseCase(repository, sesIdentityProvider, cache)

    await useCase.execute()

    expect(markVerified).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('keeps checking the remaining identities when one SES call fails', async () => {
    const first = buildSenderIdentity('first@gravina.dev')
    const second = buildSenderIdentity('second@gravina.dev')
    const markVerified = vi.fn().mockResolvedValue(success(undefined))
    const repository = {
      findUnverified: vi.fn().mockResolvedValue(success({ senderIdentities: [first, second] })),
      markVerified
    } as unknown as SenderIdentityRepository
    const getVerificationStatus = vi
      .fn()
      .mockResolvedValueOnce(failure(new CheckSesIdentityError({})))
      .mockResolvedValueOnce(success({ verified: true }))
    const sesIdentityProvider = { getVerificationStatus } as unknown as SesIdentityProvider
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const cache = { invalidate } as unknown as SenderIdentityCacheProvider
    const useCase = new SyncSenderIdentityVerificationUseCase(repository, sesIdentityProvider, cache)

    await useCase.execute()

    expect(getVerificationStatus).toHaveBeenCalledTimes(2)
    expect(markVerified).toHaveBeenCalledTimes(1)
    expect(markVerified).toHaveBeenCalledWith({ id: second.id.toString(), verifiedAt: expect.any(Date) })
  })

  it('does nothing and does not throw when findUnverified itself fails', async () => {
    const repository = {
      findUnverified: vi.fn().mockResolvedValue(failure(new FindSenderIdentityError({}))),
      markVerified: vi.fn()
    } as unknown as SenderIdentityRepository
    const getVerificationStatus = vi.fn()
    const sesIdentityProvider = { getVerificationStatus } as unknown as SesIdentityProvider
    const cache = { invalidate: vi.fn() } as unknown as SenderIdentityCacheProvider
    const useCase = new SyncSenderIdentityVerificationUseCase(repository, sesIdentityProvider, cache)

    await expect(useCase.execute()).resolves.toBeUndefined()
    expect(getVerificationStatus).not.toHaveBeenCalled()
  })
})
