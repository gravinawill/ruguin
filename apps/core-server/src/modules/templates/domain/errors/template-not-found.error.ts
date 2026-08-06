import { BaseError, StatusError } from '@ruguin/shared-domain'

export class TemplateNotFoundError extends BaseError {
  readonly name = 'TemplateNotFoundError'
  readonly status = StatusError.NOT_FOUND

  constructor(input: { templateId: string }) {
    super({ message: `Template "${input.templateId}" was not found for this project.` })
  }
}
