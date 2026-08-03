import { BaseError, StatusError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type TransactionContext } from '../../../../domain/contracts/transaction-context.contract'
import { TransactionError } from '../../../../domain/errors/transaction.error'
import { type PrismaService } from '../prisma.service'
import { PrismaTransactionManager } from '../prisma-transaction-manager'

class SampleDomainError extends BaseError {
  readonly name = 'SampleDomainError'
  readonly status = StatusError.CONFLICT

  constructor() {
    super({ message: 'business rule conflict' })
  }
}

function createPrismaStub(onTransaction?: () => never): { prisma: PrismaService; calls: { committed: boolean } } {
  const calls = { committed: false }

  const prisma = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      if (onTransaction !== undefined) onTransaction()

      const value = await work({})
      calls.committed = true

      return value
    }
  } as unknown as PrismaService

  return { calls, prisma }
}

describe('PrismaTransactionManager', () => {
  it('returns Success and commits when the work succeeds', async () => {
    const { calls, prisma } = createPrismaStub()
    const manager = new PrismaTransactionManager(prisma)

    const result = await manager.execute((): Promise<Either<SampleDomainError, { id: string }>> =>
      Promise.resolve(success({ id: 'abc' }))
    )

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value).toEqual({ id: 'abc' })
    expect(calls.committed).toBe(true)
  })

  it('hands a TransactionContext to the work without exposing the Prisma client', async () => {
    const { prisma } = createPrismaStub()
    const manager = new PrismaTransactionManager(prisma)
    const received = vi.fn()

    await manager.execute((tx: TransactionContext): Promise<Either<SampleDomainError, string>> => {
      received(tx)

      return Promise.resolve(success('ok'))
    })

    expect(received).toHaveBeenCalledOnce()
  })

  it('turns a Failure from the work into a Failure, preserving the original domain error', async () => {
    const { calls, prisma } = createPrismaStub()
    const manager = new PrismaTransactionManager(prisma)
    const domainError = new SampleDomainError()

    const result = await manager.execute((): Promise<Either<SampleDomainError, never>> =>
      Promise.resolve(failure(domainError))
    )

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value).toBe(domainError)
      expect(result.value).not.toBeInstanceOf(TransactionError)
    }
    expect(calls.committed).toBe(false)
  })

  it('never lets RollbackSignal escape as an exception', async () => {
    const { prisma } = createPrismaStub()
    const manager = new PrismaTransactionManager(prisma)

    const run = (): Promise<unknown> =>
      manager.execute((): Promise<Either<SampleDomainError, never>> =>
        Promise.resolve(failure(new SampleDomainError()))
      )

    await expect(run()).resolves.toBeDefined()
  })

  it('translates an infrastructure failure into TransactionError', async () => {
    const { prisma } = createPrismaStub(() => {
      throw new Error('connection terminated unexpectedly')
    })
    const manager = new PrismaTransactionManager(prisma)

    const result = await manager.execute((): Promise<Either<SampleDomainError, string>> =>
      Promise.resolve(success('never reached'))
    )

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value).toBeInstanceOf(TransactionError)
      expect(result.value.status).toBe(StatusError.INTERNAL_ERROR)
    }
  })
})
