import { describe, expect, it } from 'vitest'

import { SentEmailCorrelation } from '../sent-email-correlation.model.ts'

describe('SentEmailCorrelation.create', () => {
  it('builds a correlation from a trimmed sesMessageId and emailId', () => {
    const result = SentEmailCorrelation.create({ sesMessageId: ' ses-msg-1 ', emailId: ' email-1 ' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.sesMessageId).toBe('ses-msg-1')
      expect(result.value.emailId).toBe('email-1')
    }
  })

  it('rejects a sesMessageId that is empty once trimmed', () => {
    const result = SentEmailCorrelation.create({ sesMessageId: ' '.repeat(3), emailId: 'email-1' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('InvalidSentEmailCorrelationError')
      expect(result.value.message).toBe('sesMessageId must not be empty')
    }
  })

  it('rejects an emailId that is empty once trimmed', () => {
    const result = SentEmailCorrelation.create({ sesMessageId: 'ses-msg-1', emailId: ' '.repeat(3) })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('emailId must not be empty')
    }
  })
})
