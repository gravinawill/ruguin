import { Inject, Injectable } from '@nestjs/common'
import { EMAIL_SEND_REQUESTED_TOPIC, EmailSendRequestedPayloadSchema } from '@ruguin/event-schemas'
import { type BaseError, Event, ID, type JsonValue } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { OUTBOX_PORT, type OutboxPort } from '../../../../shared/domain/contracts/outbox.port'
import {
  TRANSACTION_MANAGER,
  type TransactionManager
} from '../../../../shared/domain/contracts/transaction-manager.contract'
import {
  TEMPLATE_LOOKUP_PROVIDER,
  type TemplateLookupProvider
} from '../../../templates/domain/contracts/template-lookup.provider'
import { TemplateNotFoundError } from '../../../templates/domain/errors/template-not-found.error'
import { renderTemplate } from '../../../templates/domain/render-template'
import { EMAIL_REPOSITORY, type EmailRepository } from '../../domain/contracts/repositories/email.repository'
import { Email } from '../../domain/models/email.model'

export type SendEmailUseCaseInput = Readonly<{
  projectId: string
  organizationId: string
  from: string
  to: string
  idempotencyKey?: string
}> &
  (Readonly<{ templateId: string; variables: Record<string, string> }> | Readonly<{ subject: string; html: string }>)

@Injectable()
export class SendEmailUseCase {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly transactionManager: TransactionManager,
    @Inject(EMAIL_REPOSITORY) private readonly emailRepository: EmailRepository,
    @Inject(TEMPLATE_LOOKUP_PROVIDER) private readonly templateLookup: TemplateLookupProvider,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort
  ) {}

  public async execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, Email>> {
    let subject: string
    let html: string
    let templateId: string | null = null

    if ('templateId' in input) {
      const templateResult = await this.templateLookup.findByIdAndProjectId({
        templateId: input.templateId,
        projectId: input.projectId
      })
      if (templateResult.isFailure()) return failure(templateResult.value)
      if (templateResult.value.template === null) {
        return failure(new TemplateNotFoundError({ templateId: input.templateId }))
      }

      const rendered = renderTemplate({
        subject: templateResult.value.template.subject,
        html: templateResult.value.template.html,
        variables: input.variables
      })
      if (rendered.isFailure()) return failure(rendered.value)

      subject = rendered.value.subject
      html = rendered.value.html
      templateId = input.templateId
    } else {
      subject = input.subject
      html = input.html
    }

    const idGenerated = ID.generate({ modelName: 'Email' })
    if (idGenerated.isFailure()) {
      /*
       * Same posture as Event.create(): UUID generation itself failing is treated as a bug, not
       * an expected domain failure — there is no meaningful recovery for the caller here.
       */
      throw new Error(`Failed to generate an id for a new email: ${idGenerated.value.message}`)
    }

    const emailResult = Email.create({
      id: idGenerated.value.idGenerated,
      projectId: input.projectId,
      templateId,
      idempotencyKey: input.idempotencyKey ?? null,
      from: input.from,
      to: input.to,
      subject,
      html,
      createdAt: new Date()
    })
    if (emailResult.isFailure()) return emailResult

    return this.transactionManager.execute(async (tx) => {
      const persistResult = await this.emailRepository.createIfNotExists({ email: emailResult.value, tx })
      if (persistResult.isFailure()) return failure(persistResult.value)

      const { email: persisted, created } = persistResult.value

      if (created) {
        const payload = EmailSendRequestedPayloadSchema.parse({
          emailId: persisted.id.toString(),
          organizationId: input.organizationId,
          projectId: persisted.projectId,
          from: persisted.from,
          to: persisted.to,
          subject: persisted.subject,
          html: persisted.html,
          ...(persisted.idempotencyKey !== null && { idempotencyKey: persisted.idempotencyKey })
        })
        /*
         * z.infer makes `idempotencyKey` `string | undefined` (Zod's `.optional()` convention),
         * which JsonValue's index signature rejects even though Zod never emits the key holding
         * `undefined` — it's simply absent when not supplied. The cast bridges that TypeScript-only
         * mismatch; `.parse()` above already did the real runtime validation.
         */
        const event = Event.create(EMAIL_SEND_REQUESTED_TOPIC, payload as JsonValue)
        const enqueued = await this.outbox.enqueue(
          event,
          { topic: EMAIL_SEND_REQUESTED_TOPIC, key: persisted.projectId },
          tx
        )
        if (enqueued.isFailure()) return failure(enqueued.value)
      }

      return success(persisted)
    })
  }
}
