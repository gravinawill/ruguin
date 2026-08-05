import { Injectable } from '@nestjs/common'
import { type HealthIndicatorResult } from '@nestjs/terminus'

import { PrismaService } from './prisma.service.ts'

const MAX_ERROR_LENGTH = 200
const UNKNOWN_FAILURE = 'Unknown failure while querying the database.'

function toSingleLine(error: unknown): string {
  if (!(error instanceof Error)) return UNKNOWN_FAILURE

  const collapsed = error.message.replaceAll(/\s+/gu, ' ').trim()

  if (collapsed === '') return UNKNOWN_FAILURE

  return collapsed.length > MAX_ERROR_LENGTH ? `${collapsed.slice(0, MAX_ERROR_LENGTH)}…` : collapsed
}

@Injectable()
export class DatabaseHealthIndicator {
  constructor(private readonly prisma: PrismaService) {}

  public async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const startedAt = performance.now()

    try {
      await this.prisma.$queryRaw`SELECT 1`

      return { [key]: { latencyInMs: Math.round(performance.now() - startedAt), status: 'up' } }
    } catch (error: unknown) {
      return { [key]: { error: toSingleLine(error), status: 'down' } }
    }
  }
}
