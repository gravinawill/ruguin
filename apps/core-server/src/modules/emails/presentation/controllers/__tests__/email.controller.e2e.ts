import { randomUUID } from 'node:crypto'

import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { testSeedENV } from '@ruguin/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../../../../../app.module'
import { configureApp } from '../../../../../shared/infrastructure/bootstrap/configure-app'
import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'

const SEEDED_TEMPLATE_ID = testSeedENV.TEST_SEEDED_TEMPLATE_ID
const SEEDED_API_KEY = testSeedENV.TEST_SEEDED_API_KEY
const SEEDED_PROJECT_ID = testSeedENV.TEST_SEEDED_PROJECT_ID

describe('POST /v1/emails (e2e)', () => {
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

  // --- EMAIL-3 acceptance criteria ---

  it('returns 401 for a request with no Authorization header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: {} }
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns 401 for an unknown API key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: 'Bearer not-a-real-key' },
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: {} }
    })

    expect(response.statusCode).toBe(401)
  })

  it('GET /health responds 200 without any authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
  })

  // --- EMAIL-4 acceptance criteria ---

  it('accepts a templateId + variables request, persists the rendered content, and returns 202', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Ada' } }
    })

    expect(response.statusCode).toBe(202)
    const body = JSON.parse(response.body) as { id: string; status: string }
    expect(body).toMatchObject({ status: 'queued' })

    /*
     * The seeded template (prisma/seed.ts) now comes from packages/email-templates's
     * WelcomeEmail component — subject 'Hi {{name}}', html/text both containing '{{name}}' —
     * asserting the persisted row, not just the 202, is what actually proves rendering happened.
     * html/text are checked for the substituted name rather than an exact string match: the
     * React Email component's markup (Step 7, Task 1 of this plan) is an implementation detail
     * this test should not need to know byte-for-byte.
     */
    const prisma = app.get(PrismaService)
    const row = await prisma.email.findUnique({ where: { id: body.id } })
    expect(row?.subject).toBe('Hi Ada')
    expect(row?.html).toContain('Ada')
    expect(row?.html).not.toContain('{{name}}')
    expect(row?.text).toContain('Ada')
    expect(row?.text).not.toContain('{{name}}')
  })

  it('returns 400 when the body is missing templateId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com' }
    })

    expect(response.statusCode).toBe(400)
  })

  it('returns 404 for a templateId that does not exist at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: randomUUID(), variables: {} }
    })

    expect(response.statusCode).toBe(404)
  })

  it('returns 404 for a templateId that exists but belongs to a different project', async () => {
    /*
     * A random UUID alone only proves "nonexistent template" → 404, not multi-tenant isolation.
     * This seeds a second, genuinely different project + sender identity + template so the
     * assertion actually exercises the `WHERE projectId = ...` scoping in TemplateLookupProvider,
     * not just a not-found path that would also fire for a typo.
     */
    const prisma = app.get(PrismaService)
    const otherOrganization = await prisma.organization.create({ data: { name: 'Other Org' } })
    const otherProject = await prisma.project.create({
      data: { organizationId: otherOrganization.id, name: 'Other Project' }
    })
    const otherSenderIdentity = await prisma.senderIdentity.create({
      data: {
        projectId: otherProject.id,
        name: 'Other Sender',
        email: `other+${randomUUID()}@example.com`,
        verifiedAt: new Date()
      }
    })
    const otherTemplate = await prisma.template.create({
      data: {
        projectId: otherProject.id,
        senderIdentityId: otherSenderIdentity.id,
        name: 'Other Template',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi'
      }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: otherTemplate.id, variables: {} }
    })

    expect(response.statusCode).toBe(404)
  })

  it('returns 422 when the template references a variable that was not provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: {} }
    })

    expect(response.statusCode).toBe(422)
  })

  it('returns 422 when the template points at a sender identity that is not verified', async () => {
    const prisma = app.get(PrismaService)
    const unverifiedSenderIdentity = await prisma.senderIdentity.create({
      data: {
        projectId: SEEDED_PROJECT_ID,
        name: 'Unverified Sender',
        email: `unverified+${randomUUID()}@example.com`,
        verifiedAt: null
      }
    })
    const templateWithUnverifiedSender = await prisma.template.create({
      data: {
        projectId: SEEDED_PROJECT_ID,
        senderIdentityId: unverifiedSenderIdentity.id,
        name: 'Unverified Sender Template',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi'
      }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: templateWithUnverifiedSender.id, variables: {} }
    })

    expect(response.statusCode).toBe(422)
  })

  it('accepts a request whose Idempotency-Key header is present but empty', async () => {
    /*
     * An empty header value is not a key. Forwarded as one it survives every layer's null check
     * and only fails at the outbox payload's z.string().min(1), surfacing as a 500.
     */
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': '' },
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Ada' } }
    })

    expect(response.statusCode).toBe(202)
  })

  it('returns 409 when an Idempotency-Key is reused with a different body', async () => {
    /*
     * Answering the second request with the first email's id would report 202 for a message that
     * is never queued and never sent — silent, permanent loss disguised as success. Same
     * templateId, different variables → different rendered content, which is what the repository
     * actually compares.
     */
    const idempotencyKey = `idem-${randomUUID()}`
    const headers = { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': idempotencyKey }

    const first = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers,
      payload: { to: 'first@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Ada' } }
    })
    const second = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers,
      payload: { to: 'second@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Bob' } }
    })

    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(409)
    expect(JSON.parse(second.body).error).toBe('EmailIdempotencyConflictError')

    const prisma = app.get(PrismaService)
    const rows = await prisma.email.findMany({ where: { idempotencyKey } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.to).toBe('first@example.com')
  })

  it('returns the same id for two concurrent requests sharing an Idempotency-Key', async () => {
    const idempotencyKey = `idem-${randomUUID()}`
    const payload = { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Ada' } }

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/emails',
        headers: { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': idempotencyKey },
        payload
      }),
      app.inject({
        method: 'POST',
        url: '/v1/emails',
        headers: { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': idempotencyKey },
        payload
      })
    ])

    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(202)
    expect(JSON.parse(first.body).id).toBe(JSON.parse(second.body).id)
  })
})
