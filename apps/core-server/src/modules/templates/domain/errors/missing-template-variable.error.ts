import { BaseError, StatusError } from '@ruguin/shared-domain'

export class MissingTemplateVariableError extends BaseError {
  readonly name = 'MissingTemplateVariableError'
  readonly status = StatusError.UNPROCESSABLE

  constructor(input: { variableName: string }) {
    super({ message: `Template references "{{${input.variableName}}}", which was not provided.` })
  }
}
