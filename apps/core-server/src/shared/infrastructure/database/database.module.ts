import { type DynamicModule, Module } from '@nestjs/common'

import { TRANSACTION_MANAGER } from '../../domain/contracts/transaction-manager.contract'

import { DATABASE_CONNECTION_STRING, PrismaService } from './prisma/prisma.service'
import { PrismaTransactionManager } from './prisma/prisma-transaction-manager'

@Module({})
export class DatabaseModule {
  public static forRoot(options: { connectionString: string }): DynamicModule {
    return {
      exports: [PrismaService, TRANSACTION_MANAGER],
      global: true,
      module: this,
      providers: [
        { provide: DATABASE_CONNECTION_STRING, useValue: options.connectionString },
        PrismaService,
        { provide: TRANSACTION_MANAGER, useClass: PrismaTransactionManager }
      ]
    }
  }
}
