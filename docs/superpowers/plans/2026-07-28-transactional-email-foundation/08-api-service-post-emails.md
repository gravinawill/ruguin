# Task 8: API Service — `POST /emails` route (full send flow)

**Depende de:** Task 5 (DB/schema), Task 6 (auth), Task 7 (Kafka producer + templates)
**Próximas tasks que dependem desta:** 11

## Contexto

A rota que este plano inteiro existe para entregar: autentica, valida o corpo, resolve idempotência, resolve o template (se usado) ou usa `subject`/`html` crus, grava o registro em `emails`, publica `email.send.requested` no Kafka. Consumida pelo Dispatch Worker (Task 10) e pelo teste ponta a ponta (Task 11).

## Arquivos

- Criar: `apps/api-service/src/routes/emails.ts`
- Modificar: `apps/api-service/src/app.ts` (registrar `emailsRoutes`)
- Teste: `apps/api-service/test/routes/emails.test.ts`

## Interfaces

- **Consome:** `app.authenticate` (Task 6), `app.db`/`emails`/`templates` (Task 5), `renderTemplate` (Task 7), `app.kafkaProducer` + `TOPICS.EMAIL_SEND_REQUESTED` + `EmailSendRequestedSchema` (Task 7 / `@ruguin/event-schemas`).
- **Produz:** `POST /emails` — a API externamente visível que este plano existe para entregar. Resposta `202 { id: string, status: 'queued' }` em caso de sucesso; publica um evento `EmailSendRequested` validado, com chave `emailId`. Consumida pelo Dispatch Worker (Task 10) e pelo teste ponta a ponta (Task 11).

## Passos

1. **Escrever o teste (deve falhar primeiro)**

`apps/api-service/test/routes/emails.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Kafka } from 'kafkajs';
import { buildApp } from '../../src/app.js';
import { createDb } from '../../src/db/client.js';
import { orgs, projects, apiKeys, templates, emails } from '../../src/db/schema.js';
import { TOPICS, EmailSendRequestedSchema } from '@ruguin/event-schemas';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://ruguin:ruguin@localhost:5432/ruguin';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const db = createDb(databaseUrl);

const RAW_KEY = `emails-test-key-${randomUUID()}`;

describe('POST /emails', () => {
  let orgId: string;
  let projectId: string;
  let templateId: string;

  beforeAll(async () => {
    const [org] = await db.insert(orgs).values({ name: 'Emails Test Org' }).returning();
    orgId = org.id;
    const [project] = await db.insert(projects).values({ orgId: org.id, name: 'Emails Test Project' }).returning();
    projectId = project.id;
    await db.insert(apiKeys).values({ projectId, hashedKey: createHash('sha256').update(RAW_KEY).digest('hex') });
    const [template] = await db
      .insert(templates)
      .values({ projectId, name: 'Welcome', subject: 'Hi {{name}}', html: '<p>Hello {{name}}</p>' })
      .returning();
    templateId = template.id;
  });

  afterAll(async () => {
    await db.delete(emails).where(eq(emails.projectId, projectId));
    await db.delete(apiKeys).where(eq(apiKeys.projectId, projectId));
    await db.delete(templates).where(eq(templates.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.$client.end();
  });

  it('authenticates, persists, and publishes email.send.requested', async () => {
    const app = await buildApp({ databaseUrl, redisUrl, kafkaBrokers });

    const kafka = new Kafka({ clientId: 'emails-test-consumer', brokers: kafkaBrokers });
    const consumer = kafka.consumer({ groupId: `emails-test-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPICS.EMAIL_SEND_REQUESTED, fromBeginning: false });

    const received = new Promise<unknown>((resolve) => {
      consumer.run({
        eachMessage: async ({ message }) => {
          resolve(JSON.parse(message.value?.toString() ?? '{}'));
        },
      });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/emails',
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        templateId,
        variables: { name: 'Ada' },
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body).toMatchObject({ status: 'queued' });

    const event = await received;
    const parsed = EmailSendRequestedSchema.parse(event);
    expect(parsed.emailId).toBe(body.id);
    expect(parsed.subject).toBe('Hi Ada');
    expect(parsed.html).toBe('<p>Hello Ada</p>');

    await consumer.disconnect();
    await app.close();
  }, 15000);

  it('rejects a body with neither templateId nor subject/html', async () => {
    const app = await buildApp({ databaseUrl, redisUrl, kafkaBrokers });
    const response = await app.inject({
      method: 'POST',
      url: '/emails',
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: { from: 'sender@example.com', to: 'recipient@example.com' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('returns the same email id for a repeated Idempotency-Key', async () => {
    const app = await buildApp({ databaseUrl, redisUrl, kafkaBrokers });
    const idempotencyKey = randomUUID();
    const payload = { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' };

    const first = await app.inject({
      method: 'POST',
      url: '/emails',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'idempotency-key': idempotencyKey },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/emails',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'idempotency-key': idempotencyKey },
      payload,
    });

    expect(first.json().id).toBe(second.json().id);
    await app.close();
  }, 15000);
});
```

2. **Rodar o teste e confirmar que falha**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: FAIL — `404` (a rota ainda não existe) nas chamadas de `POST /emails`.

3. **Implementar a rota**

`apps/api-service/src/routes/emails.ts`:
```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { emails, templates } from '../db/schema.js';
import { renderTemplate } from '../templates/render.js';
import { EmailSendRequestedSchema, TOPICS } from '@ruguin/event-schemas';

const SendEmailBodySchema = z
  .object({
    from: z.string().email(),
    to: z.string().email(),
    templateId: z.string().uuid().optional(),
    variables: z.record(z.string()).optional(),
    subject: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
  })
  .refine((body) => Boolean(body.templateId) || Boolean(body.subject && body.html), {
    message: 'Provide either templateId or both subject and html',
  });

// Note: since .refine() here has no `path`, a failure lands in `flatten().formErrors`
// (root-level), not `flatten().fieldErrors`. That's fine for this plan's test, which only
// asserts the status code — but don't "fix" this later assuming it's a bug in field targeting.

export const emailsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/emails', { preHandler: app.authenticate }, async (request, reply) => {
    const parseResult = SendEmailBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parseResult.error.flatten() });
    }
    const body = parseResult.data;
    const { projectId, orgId } = request.auth!;
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;

    let subject: string;
    let html: string;

    if (body.templateId) {
      const templateRows = await app.db
        .select()
        .from(templates)
        .where(and(eq(templates.id, body.templateId), eq(templates.projectId, projectId)))
        .limit(1);
      const template = templateRows[0];
      if (!template) {
        return reply.code(404).send({ error: 'template_not_found' });
      }
      const variables = body.variables ?? {};
      subject = renderTemplate(template.subject, variables);
      html = renderTemplate(template.html, variables);
    } else {
      subject = body.subject!;
      html = body.html!;
    }

    const emailId = randomUUID();
    let insertedId: string;

    if (idempotencyKey) {
      const [inserted] = await app.db
        .insert(emails)
        .values({
          id: emailId,
          projectId,
          templateId: body.templateId,
          fromAddress: body.from,
          toAddress: body.to,
          subject,
          html,
          status: 'queued',
          idempotencyKey,
        })
        .onConflictDoNothing({ target: [emails.projectId, emails.idempotencyKey] })
        .returning({ id: emails.id });

      if (!inserted) {
        // Lost the race to a concurrent request with the same key — return its id, don't republish.
        const [existing] = await app.db
          .select({ id: emails.id })
          .from(emails)
          .where(and(eq(emails.projectId, projectId), eq(emails.idempotencyKey, idempotencyKey)))
          .limit(1);
        return reply.code(202).send({ id: existing.id, status: 'queued' });
      }
      insertedId = inserted.id;
    } else {
      await app.db.insert(emails).values({
        id: emailId,
        projectId,
        templateId: body.templateId,
        fromAddress: body.from,
        toAddress: body.to,
        subject,
        html,
        status: 'queued',
      });
      insertedId = emailId;
    }

    const event = EmailSendRequestedSchema.parse({
      emailId: insertedId,
      orgId,
      projectId,
      from: body.from,
      to: body.to,
      subject,
      html,
      idempotencyKey,
      requestedAt: new Date().toISOString(),
    });

    await app.kafkaProducer.send({
      topic: TOPICS.EMAIL_SEND_REQUESTED,
      messages: [{ key: insertedId, value: JSON.stringify(event) }],
    });

    return reply.code(202).send({ id: insertedId, status: 'queued' });
  });
};
```

> **Por que mudou de "SELECT depois INSERT" para "INSERT com `onConflictDoNothing`":** o código original consultava se já existia um email com aquele `Idempotency-Key` e só inseria se não encontrasse — mas entre o SELECT e o INSERT, duas requisições concorrentes com a mesma chave (ex: um cliente que reenvia após timeout) podiam passar pelo SELECT ao mesmo tempo, e a segunda tentativa de INSERT batia na constraint única e estourava um 500 em vez de devolver o id existente. O `onConflictDoNothing` resolve a corrida no próprio banco: se perder a corrida, a query simplesmente não insere nada (`inserted` vem vazio) e o handler busca o registro que a outra requisição criou. Note que a resolução do template também subiu para antes do INSERT — agora `subject`/`html` precisam existir antes de tentar gravar a linha.

Modificar `apps/api-service/src/app.ts` — import e registro:
```ts
import { emailsRoutes } from './routes/emails.js';
```
```ts
  await app.register(healthRoutes);
  await app.register(emailsRoutes);
```

4. **Rodar os testes e confirmar que passam**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: PASS (toda a suíte do API Service, incluindo os três testes novos).

5. **Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): add POST /emails send endpoint"
```
