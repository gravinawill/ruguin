import { timingSafeEqual } from 'node:crypto'

import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { sesWebhookIngestorENV } from '@ruguin/env'

export const SES_INGESTOR_SECRET_HEADER = 'x-ses-ingestor-key'

/*
 * timingSafeEqual throws on a length mismatch instead of returning false — the explicit length
 * check both avoids that crash AND keeps this timing-safe: a naive candidateBuffer.length ===
 * expectedBuffer.length short-circuit before ever calling timingSafeEqual is the only length
 * check that doesn't itself leak content, since Buffer.from(candidate).length depends only on the
 * attacker-supplied header, never on the secret.
 */
export function isValidSharedSecret(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false

  const candidateBuffer = Buffer.from(candidate)
  const expectedBuffer = Buffer.from(expected)

  if (candidateBuffer.length !== expectedBuffer.length) return false

  return timingSafeEqual(candidateBuffer, expectedBuffer)
}

type MinimalRequest = Readonly<{ headers: Record<string, string | string[] | undefined> }>

@Injectable()
export class SesWebhookAuthGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<MinimalRequest>()
    const header = request.headers[SES_INGESTOR_SECRET_HEADER]
    const candidate = Array.isArray(header) ? header[0] : header

    if (!isValidSharedSecret(candidate, sesWebhookIngestorENV.SES_WEBHOOK_INGESTOR_SHARED_SECRET)) {
      throw new UnauthorizedException()
    }

    return true
  }
}
