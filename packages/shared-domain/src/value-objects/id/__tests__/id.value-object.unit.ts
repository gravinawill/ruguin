import { describe, expect, it } from 'vitest'

import { StatusError } from '../../../enums/index.ts'
import { ID } from '../id.value-object.ts'

const VALID_UUID_V7 = '018f4d2a-7c3b-7000-8abc-1234567890ab'

describe('ID.validate', () => {
  it('succeeds for a well-formed UUID v7', () => {
    const result = ID.validate({ id: VALID_UUID_V7, modelName: 'Email' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.idValidated.toString()).toBe(VALID_UUID_V7)
    }
  })

  it('fails with an InvalidIDError naming the modelName owner', () => {
    const result = ID.validate({ id: 'not-a-uuid', modelName: 'Email' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('Invalid ID "not-a-uuid" for "Email"')
      expect(result.value.status).toBe(StatusError.INVALID_INPUT)
    }
  })

  it('fails with an InvalidIDError naming the valueObjectName owner', () => {
    const result = ID.validate({ id: 'not-a-uuid', valueObjectName: 'ProjectID' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('Invalid ID "not-a-uuid" for "ProjectID"')
    }
  })

  it('trims surrounding whitespace before validating', () => {
    const result = ID.validate({ id: `  ${VALID_UUID_V7}  `, modelName: 'Email' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.idValidated.toString()).toBe(VALID_UUID_V7)
    }
  })
})

describe('ID.generate', () => {
  it('produces an ID that satisfies ID.validate', () => {
    const generated = ID.generate({ modelName: 'Email' })

    expect(generated.isSuccess()).toBe(true)
    if (generated.isSuccess()) {
      const validated = ID.validate({ id: generated.value.idGenerated.toString(), modelName: 'Email' })
      expect(validated.isSuccess()).toBe(true)
    }
  })
})

describe('ID#equals', () => {
  it('is true for the same value regardless of case', () => {
    const a = ID.validate({ id: VALID_UUID_V7, modelName: 'Email' })
    const b = ID.validate({ id: VALID_UUID_V7.toUpperCase(), modelName: 'Email' })

    if (a.isSuccess() && b.isSuccess()) {
      expect(a.value.idValidated.equals({ otherID: b.value.idValidated })).toBe(true)
    }
  })

  it('is false for a different value', () => {
    const a = ID.validate({ id: VALID_UUID_V7, modelName: 'Email' })
    const generated = ID.generate({ modelName: 'Email' })

    if (a.isSuccess() && generated.isSuccess()) {
      expect(a.value.idValidated.equals({ otherID: generated.value.idGenerated })).toBe(false)
    }
  })
})

describe('ID#getPartition', () => {
  it('is deterministic and within range for the same ID', () => {
    const result = ID.validate({ id: VALID_UUID_V7, modelName: 'Email' })

    if (result.isSuccess()) {
      const first = result.value.idValidated.getPartition({ totalShards: 4 })
      const second = result.value.idValidated.getPartition({ totalShards: 4 })

      expect(first).toBe(second)
      expect(first).toBeGreaterThanOrEqual(0)
      expect(first).toBeLessThan(4)
    }
  })
})
