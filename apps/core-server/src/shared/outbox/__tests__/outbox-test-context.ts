import { PrismaService } from '../../database/prisma.service'

export const TEST_DATABASE_URL: string =
  process.env.DATABASE_URL ?? 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=core_server'

export const createTestPrismaService = (): PrismaService => new PrismaService(TEST_DATABASE_URL)

export const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
