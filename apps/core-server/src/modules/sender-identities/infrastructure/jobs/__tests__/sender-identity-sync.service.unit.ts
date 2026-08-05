import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { type SyncSenderIdentityVerificationUseCase } from '../../../application/use-cases/sync-sender-identity-verification.use-case'
import { SenderIdentitySyncService } from '../sender-identity-sync.service'

describe('SenderIdentitySyncService#sync', () => {
  it('runs the use case', async () => {
    const execute = vi.fn().mockResolvedValue(undefined)
    const useCase = { execute } as unknown as SyncSenderIdentityVerificationUseCase
    const service = new SenderIdentitySyncService(useCase)

    await service.sync()

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('skips a tick entirely while the previous one is still running', async () => {
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void>() is the documented signature for a promise with no resolved value
    const firstRun = Promise.withResolvers<void>()
    const execute = vi.fn().mockReturnValueOnce(firstRun.promise).mockResolvedValue(undefined)
    const useCase = { execute } as unknown as SyncSenderIdentityVerificationUseCase
    const service = new SenderIdentitySyncService(useCase)

    const first = service.sync()
    const second = service.sync()
    firstRun.resolve()
    await Promise.all([first, second])

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('swallows a thrown error instead of letting it escape the interval timer', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(vi.fn())
    const execute = vi.fn().mockRejectedValue(new Error('unexpected'))
    const useCase = { execute } as unknown as SyncSenderIdentityVerificationUseCase
    const service = new SenderIdentitySyncService(useCase)

    await expect(service.sync()).resolves.toBeUndefined()
  })
})
