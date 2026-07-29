# Task 11: End-to-end smoke test across both services

**Depende de:** Task 8 (`POST /emails`), Task 10 (consumer do Dispatch Worker)
**Próximas tasks que dependem desta:** nenhuma — esta é a prova final deste plano

## Contexto

A prova de que a Task 1 até a Task 10 realmente formam um pipeline funcionando: uma requisição HTTP real ao API Service chega no Postgres, no Kafka, no Dispatch Worker, e numa chamada real (LocalStack) à SES, voltando pelo Kafka como um evento `email.status.updated` com `status: "sent"`. Depois desta task, `pnpm test` na raiz do repo é a prova automatizada — o que CI (quando for adicionado) vai rodar.

## Arquivos

- Teste: `apps/api-service/test/e2e/send-email.e2e.test.ts`
- Criar: `apps/dispatch-worker/src/lib.ts`
- Modificar: `apps/dispatch-worker/package.json` (`"main"`/`"types"` apontando para `dist/lib.js`)
- Modificar: `apps/api-service/package.json` (adicionar `@ruguin/dispatch-worker` como devDependency)

## Interfaces

- **Consome:** `buildApp` (Task 8, do próprio `src/` do `@ruguin/api-service`), e de `@ruguin/dispatch-worker`: `createRedis`, `createSesClient`, `createKafkaClient`, `createConsumer`, `createProducer`, `runConsumer` (Task 10) — importados diretamente, já que este teste fica conceitualmente "acima" dos dois serviços para provar a costura entre eles.
- **Produz:** nada consumido depois — esta é a prova final de "software funcionando e testável" deste plano.

## Passos

1. **Adicionar dependência para o teste do API Service conseguir importar os módulos do Dispatch Worker**

Adicionar em `apps/api-service/package.json`, em `"devDependencies"`:
```json
"@ruguin/dispatch-worker": "workspace:*"
```

Rodar `pnpm install` na raiz do repo, depois `pnpm --filter @ruguin/dispatch-worker build`.

2. **Criar a superfície de re-export do Dispatch Worker**

`apps/dispatch-worker/src/index.ts` é o entrypoint executável (tem `main().catch(...)` no topo) — não dá para importar dele num teste sem disparar o processo principal. Criar `apps/dispatch-worker/src/lib.ts`:
```ts
export { createRedis } from './redis.js';
export { createSesClient } from './ses-client.js';
export { createKafkaClient, createConsumer, createProducer } from './kafka.js';
export { runConsumer, type RunConsumerOptions } from './consumer.js';
```

Atualizar `apps/dispatch-worker/package.json`:
```json
"main": "./dist/lib.js",
"types": "./dist/lib.d.ts",
```

Rebuildar: `pnpm --filter @ruguin/dispatch-worker build`.

3. **Escrever o teste ponta a ponta**

`apps/api-service/test/e2e/send-email.e2e.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Kafka } from 'kafkajs';
import { buildApp } from '../../src/app.js';
import { createDb } from '../../src/db/client.js';
import { orgs, projects, apiKeys, emails } from '../../src/db/schema.js';
import { TOPICS, EmailStatusUpdatedSchema } from '@ruguin/event-schemas';
import {
  createRedis as createWorkerRedis,
  createSesClient,
  createKafkaClient,
  createConsumer,
  createProducer,
  runConsumer,
} from '@ruguin/dispatch-worker';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://ruguin:ruguin@localhost:5432/ruguin';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const db = createDb(databaseUrl);

const RAW_KEY = `e2e-key-${randomUUID()}`;

describe('end-to-end: send an email through API Service and Dispatch Worker', () => {
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    const [org] = await db.insert(orgs).values({ name: 'E2E Org' }).returning();
    orgId = org.id;
    const [project] = await db.insert(projects).values({ orgId: org.id, name: 'E2E Project' }).returning();
    projectId = project.id;
    await db.insert(apiKeys).values({ projectId, hashedKey: createHash('sha256').update(RAW_KEY).digest('hex') });

    const kafka = createKafkaClient(kafkaBrokers);
    const consumer = await createConsumer(kafka, `e2e-dispatch-worker-${Date.now()}`);
    const producer = await createProducer(kafka);
    const redis = createWorkerRedis(redisUrl);
    const sesClient = createSesClient();

    void runConsumer({
      consumer,
      producer,
      redis,
      sesClient,
      rateLimitKey: `e2e:ses-rate-limit:${Date.now()}`,
      rateLimitCapacity: 10,
      rateLimitRefillPerSecond: 10,
    });

    // Wait for the consumer group to actually finish joining/rebalancing before publishing —
    // see the note in Task 10 on why a fixed sleep here would be flaky.
    await new Promise<void>((resolve) => {
      consumer.on(consumer.events.GROUP_JOIN, () => resolve());
    });
  });

  afterAll(async () => {
    await db.delete(emails).where(eq(emails.projectId, projectId));
    await db.delete(apiKeys).where(eq(apiKeys.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.$client.end();
  });

  it('POST /emails results in a "sent" email.status.updated event', async () => {
    const app = await buildApp({ databaseUrl, redisUrl, kafkaBrokers });

    const kafka = new Kafka({ clientId: 'e2e-status-consumer', brokers: kafkaBrokers });
    const statusConsumer = kafka.consumer({ groupId: `e2e-status-${Date.now()}` });
    await statusConsumer.connect();
    await statusConsumer.subscribe({ topic: TOPICS.EMAIL_STATUS_UPDATED, fromBeginning: true });

    const response = await app.inject({
      method: 'POST',
      url: '/emails',
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'End to end test',
        html: '<p>It works</p>',
      },
    });

    expect(response.statusCode).toBe(202);
    const emailId = response.json().id as string;

    const received = new Promise<unknown>((resolve) => {
      statusConsumer.run({
        eachMessage: async ({ message }) => {
          const parsed = JSON.parse(message.value?.toString() ?? '{}');
          if (parsed.emailId === emailId) resolve(parsed);
        },
      });
    });

    const statusEvent = EmailStatusUpdatedSchema.parse(await received);
    expect(statusEvent.status).toBe('sent');
    expect(statusEvent.sesMessageId).toBeTruthy();

    await statusConsumer.disconnect();
    await app.close();
  }, 20000);
});
```

4. **Rodar o teste ponta a ponta**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: PASS — a suíte inteira (health, auth, templates, kafka, emails, e2e) fica verde, e o teste e2e especificamente prova que uma requisição HTTP chega ao Postgres, ao Kafka, ao Dispatch Worker, e a uma chamada real (LocalStack) de SES, indo e voltando pelo Kafka.

5. **Rodar a suíte completa do monorepo como checagem final**

Rodar: `pnpm test` (na raiz do repo — roda `turbo run test`, que builda `@ruguin/event-schemas` e `@ruguin/dispatch-worker` primeiro por causa do `dependsOn: ["^build"]` do `turbo.json`, e então testa todos os pacotes)
Esperado: todos os pacotes reportam PASS.

6. **Commit**

```bash
git add apps/api-service apps/dispatch-worker
git commit -m "test: add end-to-end smoke test covering API Service -> Kafka -> Dispatch Worker -> SES"
```

## Verificação manual (opcional, além dos testes automatizados)

1. `pnpm infra:up` sobe Postgres, Valkey, Kafka e LocalStack (Task 2).
2. `pnpm --filter @ruguin/api-service run db:migrate` aplica o schema (Task 5).
3. `pnpm --filter @ruguin/api-service dev` e `pnpm --filter @ruguin/dispatch-worker dev` rodam os dois serviços localmente.
4. Um `curl -X POST http://localhost:3000/emails -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"from":"a@example.com","to":"b@example.com","subject":"Hi","html":"<p>Hi</p>"}'` manual (depois de semear um org/project/api key à mão ou via um script curto) retorna `202` e, em um ou dois segundos, os logs do Dispatch Worker mostram que ele chamou a SES e publicou um evento de status `sent`.
