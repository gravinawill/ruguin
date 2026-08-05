import { type Either, failure, success } from '@ruguin/utils'

import { MissingTemplateVariableError } from './errors/missing-template-variable.error'

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g

function substitute(text: string, variables: Record<string, string>): Either<MissingTemplateVariableError, string> {
  let missingVariableName: string | undefined

  const replaced = text.replaceAll(VARIABLE_PATTERN, (_match, variableName: string) => {
    /*
     * Once one variable is known missing, stop substituting — the placeholder itself is
     * irrelevant, this branch only exists to short-circuit the remaining replacements cheaply.
     */
    if (missingVariableName !== undefined) return ''

    const value = variables[variableName]
    if (value === undefined) {
      missingVariableName = variableName
      return ''
    }

    return value
  })

  if (missingVariableName !== undefined) {
    return failure(new MissingTemplateVariableError({ variableName: missingVariableName }))
  }

  return success(replaced)
}

export function renderTemplate(input: {
  subject: string
  html: string
  variables: Record<string, string>
}): Either<MissingTemplateVariableError, { subject: string; html: string }> {
  const subjectResult = substitute(input.subject, input.variables)
  if (subjectResult.isFailure()) {
    return subjectResult as unknown as Either<MissingTemplateVariableError, { subject: string; html: string }>
  }

  const htmlResult = substitute(input.html, input.variables)
  if (htmlResult.isFailure()) {
    return htmlResult as unknown as Either<MissingTemplateVariableError, { subject: string; html: string }>
  }

  return success({ subject: subjectResult.value, html: htmlResult.value })
}
