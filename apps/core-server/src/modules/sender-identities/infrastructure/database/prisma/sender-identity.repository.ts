import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'
import { type SenderIdentityRepository as SenderIdentityRepositoryContract } from '../../../domain/contracts/repositories/sender-identity.repository'
import { CreateSenderIdentityError } from '../../../domain/errors/create-sender-identity.error'
import { DuplicateSenderIdentityEmailError } from '../../../domain/errors/duplicate-sender-identity-email.error'
import { FindSenderIdentityError } from '../../../domain/errors/find-sender-identity.error'
import { InvalidSenderIdentityError } from '../../../domain/errors/invalid-sender-identity.error'
import { SenderIdentity } from '../../../domain/models/sender-identity.model'

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

@Injectable()
export class SenderIdentityRepository implements SenderIdentityRepositoryContract {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    projectId: string
    name: string
    email: string
    verifiedAt: Date | null
    createdAt: Date
  }): Either<InvalidSenderIdentityError, SenderIdentity> {
    const idResult = ID.validate({ id: row.id, modelName: 'SenderIdentity' })
    if (idResult.isFailure()) return failure(new InvalidSenderIdentityError({ reason: idResult.value.message }))

    return SenderIdentity.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      name: row.name,
      email: row.email,
      verifiedAt: row.verifiedAt,
      createdAt: row.createdAt
    })
  }

  public async create(input: {
    senderIdentity: SenderIdentity
  }): Promise<Either<CreateSenderIdentityError | DuplicateSenderIdentityEmailError, SenderIdentity>> {
    try {
      const row = await this.prisma.senderIdentity.create({
        data: {
          id: input.senderIdentity.id.toString(),
          projectId: input.senderIdentity.projectId,
          name: input.senderIdentity.name,
          email: input.senderIdentity.email,
          verifiedAt: input.senderIdentity.verifiedAt
        }
      })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new CreateSenderIdentityError({ error: mapped.value }))

      return success(mapped.value)
    } catch (error: unknown) {
      if (isUniqueConstraintViolation(error)) {
        return failure(new DuplicateSenderIdentityEmailError({ email: input.senderIdentity.email }))
      }
      return failure(new CreateSenderIdentityError({ error }))
    }
  }

  public async findById(input: {
    id: string
  }): Promise<Either<FindSenderIdentityError, { senderIdentity: SenderIdentity | null }>> {
    try {
      const row = await this.prisma.senderIdentity.findUnique({ where: { id: input.id } })
      if (row === null) return success({ senderIdentity: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindSenderIdentityError({ error: mapped.value }))

      return success({ senderIdentity: mapped.value })
    } catch (error: unknown) {
      return failure(new FindSenderIdentityError({ error }))
    }
  }

  public async findManyByProjectId(input: {
    projectId: string
  }): Promise<Either<FindSenderIdentityError, { senderIdentities: SenderIdentity[] }>> {
    try {
      const rows = await this.prisma.senderIdentity.findMany({
        where: { projectId: input.projectId },
        orderBy: { createdAt: 'asc' }
      })

      const senderIdentities: SenderIdentity[] = []
      for (const row of rows) {
        const mapped = this.toDomain(row)
        if (mapped.isFailure()) return failure(new FindSenderIdentityError({ error: mapped.value }))
        senderIdentities.push(mapped.value)
      }

      return success({ senderIdentities })
    } catch (error: unknown) {
      return failure(new FindSenderIdentityError({ error }))
    }
  }

  public async findUnverified(): Promise<Either<FindSenderIdentityError, { senderIdentities: SenderIdentity[] }>> {
    try {
      const rows = await this.prisma.senderIdentity.findMany({ where: { verifiedAt: null } })

      const senderIdentities: SenderIdentity[] = []
      for (const row of rows) {
        const mapped = this.toDomain(row)
        if (mapped.isFailure()) return failure(new FindSenderIdentityError({ error: mapped.value }))
        senderIdentities.push(mapped.value)
      }

      return success({ senderIdentities })
    } catch (error: unknown) {
      return failure(new FindSenderIdentityError({ error }))
    }
  }

  public async markVerified(input: { id: string; verifiedAt: Date }): Promise<Either<FindSenderIdentityError, void>> {
    try {
      await this.prisma.senderIdentity.update({ where: { id: input.id }, data: { verifiedAt: input.verifiedAt } })
      return success(undefined)
    } catch (error: unknown) {
      return failure(new FindSenderIdentityError({ error }))
    }
  }
}
