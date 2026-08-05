import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type CorrelationPort } from '../../../domain/contracts/correlation.port.ts'
import { SentEmailCorrelation } from '../../../domain/models/sent-email-correlation.model.ts'
import { RecordSentCorrelationUseCase } from '../record-sent-correlation.use-case.ts'

function fakeCorrelation(overrides: Partial<CorrelationPort>): CorrelationPort {
  return overrides as unknown as CorrelationPort
}

function buildCorrelation(): SentEmailCorrelation {
  const created = SentEmailCorrelation.create({ sesMessageId: 'ses-msg-1', emailId: 'email-1' })
  if (created.isFailure()) throw new Error(`test fixture is invalid: ${created.value.message}`)

  return created.value
}

describe('RecordSentCorrelationUseCase', () => {
  it('upserts the correlation with the given sesMessageId and emailId', async () => {
    const upsert = vi.fn().mockResolvedValue(success(undefined))
    const useCase = new RecordSentCorrelationUseCase(fakeCorrelation({ upsert }))

    const result = await useCase.execute(buildCorrelation())

    expect(result.isSuccess()).toBe(true)
    expect(upsert).toHaveBeenCalledWith({ sesMessageId: 'ses-msg-1', emailId: 'email-1' })
  })

  it('propagates a failure from the correlation port', async () => {
    const correlationError = { name: 'CorrelationUpsertError', message: 'db down' }
    const upsert = vi.fn().mockResolvedValue(failure(correlationError))
    const useCase = new RecordSentCorrelationUseCase(fakeCorrelation({ upsert }))

    const result = await useCase.execute(buildCorrelation())

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(correlationError)
  })
})
