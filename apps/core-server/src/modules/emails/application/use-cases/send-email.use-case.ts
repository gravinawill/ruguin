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
  SENDER_IDENTITY_CACHE_PROVIDER,
  type SenderIdentityCacheProvider
} from '../../../sender-identities/domain/contracts/sender-identity-cache.provider'
import { SenderIdentityNotVerifiedError } from '../../../sender-identities/domain/errors/sender-identity-not-verified.error'
import {
  TEMPLATE_LOOKUP_PROVIDER,
  type TemplateLookupProvider
} from '../../../templates/domain/contracts/template-lookup.provider'
import { TemplateNotFoundError } from '../../../templates/domain/errors/template-not-found.error'
import { renderTemplate } from '../../../templates/domain/render-template'
import { EMAIL_REPOSITORY, type EmailRepository } from '../../domain/contracts/repositories/email.repository'
import { InvalidEmailPayloadError } from '../../domain/errors/models/invalid-email-payload.error'
import { Email } from '../../domain/models/email.model'

export type SendEmailUseCaseInput = Readonly<{
  projectId: string
  organizationId: string
  to: string
  templateId: string
  variables: Record<string, string>
  idempotencyKey?: string
}>

@Injectable()
export class SendEmailUseCase {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly transactionManager: TransactionManager,
    @Inject(EMAIL_REPOSITORY) private readonly emailRepository: EmailRepository,
    @Inject(TEMPLATE_LOOKUP_PROVIDER) private readonly templateLookup: TemplateLookupProvider,
    @Inject(SENDER_IDENTITY_CACHE_PROVIDER) private readonly senderIdentityCache: SenderIdentityCacheProvider,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort
  ) {}

  public async execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, Email>> {
    const templateResult = await this.templateLookup.findByIdAndProjectId({
      templateId: input.templateId,
      projectId: input.projectId
    })
    if (templateResult.isFailure()) return failure(templateResult.value)
    if (templateResult.value.template === null) {
      return failure(new TemplateNotFoundError({ templateId: input.templateId }))
    }
    const { template } = templateResult.value

    /*
     * Resolved from the cache-backed contract, not the raw repository — the send path is the hot
     * path this cache exists for (design spec decision 5). A miss (deleted row, cache/DB
     * disagreement) is treated exactly like "not verified": there is no legitimate send without a
     * resolvable, verified sender.
     */
    const senderIdentityResult = await this.senderIdentityCache.get({ senderIdentityId: template.senderIdentityId })
    if (senderIdentityResult.isFailure()) return failure(senderIdentityResult.value)
    const senderIdentity = senderIdentityResult.value
    if (!senderIdentity?.isVerified()) {
      return failure(new SenderIdentityNotVerifiedError({ senderIdentityId: template.senderIdentityId }))
    }

    const rendered = renderTemplate({ subject: template.subject, html: template.html, variables: input.variables })
    if (rendered.isFailure()) return failure(rendered.value)

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
      templateId: input.templateId,
      senderIdentityId: senderIdentity.id.toString(),
      idempotencyKey: input.idempotencyKey ?? null,
      from: senderIdentity.email,
      to: input.to,
      subject: rendered.value.subject,
      html: rendered.value.html,
      createdAt: new Date()
    })
    if (emailResult.isFailure()) return emailResult

    /*
     * Validated up front, from the not-yet-persisted email, so a malformed payload never opens a
     * DB transaction. safeParse (never .parse()) keeps this an Either failure, matching the
     * method's own contract, instead of a throw that would otherwise surface as a generic 500.
     */
    const payloadParsed = EmailSendRequestedPayloadSchema.safeParse({
      emailId: emailResult.value.id.toString(),
      organizationId: input.organizationId,
      projectId: emailResult.value.projectId,
      from: emailResult.value.from,
      to: emailResult.value.to,
      subject: emailResult.value.subject,
      html: emailResult.value.html,
      ...(emailResult.value.idempotencyKey !== null && { idempotencyKey: emailResult.value.idempotencyKey })
    })
    if (!payloadParsed.success) return failure(new InvalidEmailPayloadError({ error: payloadParsed.error }))

    /*
     * z.infer makes `idempotencyKey` `string | undefined` (Zod's `.optional()` convention), which
     * JsonValue's index signature rejects even though Zod never emits the key holding `undefined`
     * — it's simply absent when not supplied. The cast bridges that TypeScript-only mismatch;
     * safeParse above already did the real runtime validation.
     */
    const payload = payloadParsed.data as JsonValue

    return this.transactionManager.execute(async (tx) => {
      const persistResult = await this.emailRepository.createIfNotExists({ email: emailResult.value, tx })
      if (persistResult.isFailure()) return failure(persistResult.value)

      const { email: persisted, created } = persistResult.value

      if (created) {
        const event = Event.create(EMAIL_SEND_REQUESTED_TOPIC, payload)
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
