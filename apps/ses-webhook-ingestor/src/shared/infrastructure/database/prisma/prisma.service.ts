import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from './generated/client'

export const DATABASE_CONNECTION_STRING = Symbol('DATABASE_CONNECTION_STRING')

export function resolveSchemaFrom(connectionString: string): Record<string, never> | { schema: string } {
  const schema = new URL(connectionString).searchParams.get('schema')

  return schema === null || schema === '' ? {} : { schema }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(DATABASE_CONNECTION_STRING) connectionString: string) {
    const resolvedSchema = resolveSchemaFrom(connectionString)
    super({ adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5000 }, resolvedSchema) })
  }

  public async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
