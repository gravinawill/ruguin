import { render } from '@react-email/render'

import { subject, WelcomeEmail } from './templates/welcome'

export async function renderWelcomeEmailTemplate(): Promise<{ subject: string; html: string; text: string }> {
  const element = <WelcomeEmail name='{{name}}' />
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])

  return { subject, html, text }
}
