import { describe, expect, it } from 'vitest'

import { renderTemplate } from '../render-template'

describe('renderTemplate', () => {
  it('substitutes every {{variable}} occurrence in subject, html, and text', () => {
    const result = renderTemplate({
      subject: 'Hi {{name}}',
      html: '<p>Welcome, {{name}}! Your plan is {{plan}}.</p>',
      text: 'Welcome, {{name}}! Your plan is {{plan}}.',
      variables: { name: 'Ada', plan: 'Pro' }
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.subject).toBe('Hi Ada')
      expect(result.value.html).toBe('<p>Welcome, Ada! Your plan is Pro.</p>')
      expect(result.value.text).toBe('Welcome, Ada! Your plan is Pro.')
    }
  })

  it('fails explicitly when a variable referenced only in text is missing', () => {
    const result = renderTemplate({
      subject: 'Hi',
      html: '<p>ok</p>',
      text: 'Hi {{name}}',
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
  })

  it('fails explicitly when a referenced variable is missing, never emitting the literal placeholder', () => {
    const result = renderTemplate({ subject: 'Hi {{name}}', html: '<p>ok</p>', text: 'ok', variables: {} })

    expect(result.isFailure()).toBe(true)
  })

  it('is a no-op when the template has no placeholders', () => {
    const result = renderTemplate({ subject: 'Hello', html: '<p>Hello</p>', text: 'Hello', variables: {} })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value).toEqual({ subject: 'Hello', html: '<p>Hello</p>', text: 'Hello' })
    }
  })
})
