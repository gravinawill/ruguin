import { randomUUID } from 'node:crypto'

import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { testSeedENV } from '@ruguin/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../../../../../app.module'
import { configureApp } from '../../../../../shared/infrastructure/bootstrap/configure-app'

const SEEDED_API_KEY = testSeedENV.TEST_SEEDED_API_KEY
const SEEDED_SENDER_IDENTITY_ID = testSeedENV.TEST_SEEDED_SENDER_IDENTITY_ID

/*
 * LocalStack has required a valid auth token (even for free-tier community features) since
 * 2026-03-23 — 'dummy' fails license activation and the container never starts (confirmed: exit
 * code 55, crash loop). Without a real token from app.localstack.cloud there is no way to reach
 * SES v2 here, so the two tests that call AwsSesIdentityProvider are skipped rather than reported
 * as a false failure of this suite. This is the open LocalStack/SES v2 risk from the design spec;
 * get a real token and unset/replace LOCALSTACK_AUTH_TOKEN=dummy to actually exercise them.
 */
const hasRealLocalStackToken =
  process.env.LOCALSTACK_AUTH_TOKEN !== undefined && process.env.LOCALSTACK_AUTH_TOKEN !== 'dummy'

/*
 * URLs below are '/v1/sender-identities': SenderIdentityController is a bare `@Controller()` with
 * no explicit version, same as EmailController, so it inherits the global `defaultVersion: '1'`
 * from configureApp's `app.enableVersioning(...)` — unlike HealthController, which opts out via
 * `VERSION_NEUTRAL`. Confirmed empirically: an unversioned '/sender-identities' 404s.
 */
describe('POST /sender-identities, GET /sender-identities (e2e)', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await configureApp(app)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 401 for a request with no Authorization header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sender-identities',
      payload: { name: 'Will Gravina', email: `will+${randomUUID()}@gravina.dev` }
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns 400 for a body missing email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { name: 'Will Gravina' }
    })

    expect(response.statusCode).toBe(400)
  })

  it.skipIf(!hasRealLocalStackToken)('registers a new sender identity and returns it unverified', async () => {
    const email = `will+${randomUUID()}@gravina.dev`

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { name: 'Will Gravina', email }
    })

    expect(response.statusCode).toBe(201)
    const body = JSON.parse(response.body) as {
      id: string
      name: string
      email: string
      domain: string
      verifiedAt: string | null
    }
    expect(body).toMatchObject({ name: 'Will Gravina', email, domain: 'gravina.dev', verifiedAt: null })
  })

  it.skipIf(!hasRealLocalStackToken)('returns 409 when the same email is registered twice', async () => {
    const email = `duplicate+${randomUUID()}@gravina.dev`
    const first = await app.inject({
      method: 'POST',
      url: '/v1/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { name: 'Will Gravina', email }
    })
    expect(first.statusCode).toBe(201)

    const second = await app.inject({
      method: 'POST',
      url: '/v1/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { name: 'Will Gravina (again)', email }
    })

    expect(second.statusCode).toBe(409)
  })

  it('lists the seeded sender identity for the authenticated project', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` }
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body) as Array<{ id: string }>
    expect(body.some((senderIdentity) => senderIdentity.id === SEEDED_SENDER_IDENTITY_ID)).toBe(true)
  })
})
