import { type DynamicModule, Module } from '@nestjs/common'

import { DATABASE_CONNECTION_STRING, PrismaService } from './prisma/prisma.service.ts'

@Module({})
export class DatabaseModule {
  public static forRoot(options: { connectionString: string }): DynamicModule {
    return {
      module: this,
      global: true,
      providers: [{ provide: DATABASE_CONNECTION_STRING, useValue: options.connectionString }, PrismaService],
      exports: [PrismaService]
    }
  }
}
