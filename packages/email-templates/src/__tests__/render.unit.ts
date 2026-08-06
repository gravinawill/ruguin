import { describe, expect, it } from 'vitest'

import { renderWelcomeEmailTemplate } from '../render'

describe('renderWelcomeEmailTemplate', () => {
  it('returns the subject with the {{name}} placeholder literal', async () => {
    const result = await renderWelcomeEmailTemplate()

    expect(result.subject).toBe('Hi {{name}}')
  })

  it('returns html containing the {{name}} placeholder literal, not a substituted value', async () => {
    const result = await renderWelcomeEmailTemplate()

    expect(result.html).toContain('{{name}}')
  })

  it('returns a plain-text version containing the {{name}} placeholder literal', async () => {
    const result = await renderWelcomeEmailTemplate()

    expect(result.text).toContain('{{name}}')
  })

  it('returns html wrapped in a full HTML document', async () => {
    const result = await renderWelcomeEmailTemplate()

    expect(result.html).toContain('<html')
  })
})
