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

    /*
     * Object.hasOwn, not `variables[variableName] === undefined`: a plain object literal
     * inherits from Object.prototype, so a template referencing {{toString}} or
     * {{constructor}} would otherwise resolve to a prototype method (a function, not
     * undefined) and slip past the missing-variable check entirely.
     */
    if (!Object.hasOwn(variables, variableName)) {
      missingVariableName = variableName
      return ''
    }

    // Object.hasOwn just confirmed the key is present; noUncheckedIndexedAccess can't see that.
    return variables[variableName]!
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
  if (subjectResult.isFailure()) return failure(subjectResult.value)

  const htmlResult = substitute(input.html, input.variables)
  if (htmlResult.isFailure()) return failure(htmlResult.value)

  return success({ subject: subjectResult.value, html: htmlResult.value })
}
