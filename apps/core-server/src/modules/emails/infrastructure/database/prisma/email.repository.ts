import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type Prisma } from '../../../../../shared/infrastructure/database/prisma/generated/client'
import { type EmailRepository as EmailRepositoryContract } from '../../../domain/contracts/repositories/email.repository'
import { CreateEmailError } from '../../../domain/errors/models/create-email.error'
import { InvalidEmailError } from '../../../domain/errors/models/invalid-email.error'
import { Email } from '../../../domain/models/email.model'

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

@Injectable()
export class EmailRepository implements EmailRepositoryContract {
  private toDomain(row: {
    id: string
    projectId: string
    templateId: string | null
    idempotencyKey: string | null
    from: string
    to: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidEmailError, Email> {
    const idResult = ID.validate({ id: row.id, modelName: 'Email' })
    if (idResult.isFailure()) return failure(new InvalidEmailError({ reason: idResult.value.message }))

    return Email.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      templateId: row.templateId,
      idempotencyKey: row.idempotencyKey,
      from: row.from,
      to: row.to,
      subject: row.subject,
      html: row.html,
      createdAt: row.createdAt
    })
  }

  public async createIfNotExists(input: {
    email: Email
    tx: TransactionContext
  }): Promise<Either<CreateEmailError, { email: Email; created: boolean }>> {
    const client = input.tx as unknown as Prisma.TransactionClient
    const savepoint = `create_email_${input.email.id.toString().replaceAll('-', '_')}`

    try {
      /*
       * Postgres marks the whole enclosing transaction as aborted the instant the unique-index
       * insert fails — every statement after it, including the recovery findFirst below, would
       * error with 25P02 ("current transaction is aborted") unless it first rolls back to a
       * savepoint taken before the insert. Issued inside this try: a network failure on the
       * SAVEPOINT call itself is the same class of infra failure as the insert failing, and this
       * method's contract (Either, never a thrown rejection) must hold for it too. The savepoint
       * name is derived from the row's own id so concurrent createIfNotExists calls sharing this
       * transaction (none today, but nothing stops a future orchestration use case) never
       * collide on the savepoint stack.
       */
      await client.$executeRawUnsafe(`SAVEPOINT ${savepoint}`)

      const row = await client.email.create({
        data: {
          id: input.email.id.toString(),
          projectId: input.email.projectId,
          templateId: input.email.templateId,
          idempotencyKey: input.email.idempotencyKey,
          from: input.email.from,
          to: input.email.to,
          subject: input.email.subject,
          html: input.email.html
        }
      })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new CreateEmailError({ error: mapped.value }))

      return success({ email: mapped.value, created: true })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) return failure(new CreateEmailError({ error }))

      try {
        await client.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      } catch (rollbackError: unknown) {
        return failure(new CreateEmailError({ error: rollbackError }))
      }

      /*
       * A NULL idempotencyKey never matches the partial index's WHERE clause (it only covers
       * idempotencyKey IS NOT NULL), so a P2002 here can only be a primary-key collision on `id`
       * — astronomically unlikely with UUIDv7, but silently wrong if mishandled: falling through
       * to the recovery query below with idempotencyKey: null would return an ARBITRARY earlier
       * email in this project that also has no idempotency key, report a stranger's id as
       * "already sent this request", and silently drop the real send.
       */
      if (input.email.idempotencyKey === null) return failure(new CreateEmailError({ error }))

      /*
       * Lost the race on (projectId, idempotencyKey): the winner's row is what the caller must
       * treat as the result — never a second outbox event for the same logical request. The
       * partial index guarantees at most one row exists here, so findFirst is not itself racy.
       */
      const existingRow = await client.email.findFirst({
        where: { projectId: input.email.projectId, idempotencyKey: input.email.idempotencyKey }
      })
      if (existingRow === null) return failure(new CreateEmailError({ error }))

      const mapped = this.toDomain(existingRow)
      if (mapped.isFailure()) return failure(new CreateEmailError({ error: mapped.value }))

      return success({ email: mapped.value, created: false })
    }
  }
}
