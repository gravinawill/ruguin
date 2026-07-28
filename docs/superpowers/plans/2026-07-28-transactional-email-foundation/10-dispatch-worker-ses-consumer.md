# Task 10: Dispatch Worker — SES client + Kafka consumer send flow

**Depende de:** Task 2 (Kafka + LocalStack rodando), Task 3 (`@ruguin/event-schemas`), Task 9 (rate limiter)
**Próximas tasks que dependem desta:** 11

## Contexto

O coração do Dispatch Worker: consome `email.send.requested`, adquire um token do rate limiter (Task 9) com espera limitada, chama `SendEmail` na AWS SES (via LocalStack em dev/teste), e publica `email.status.updated` com `sent` ou `failed`. É o outro lado do caminho de envio que a Task 8 inicia.

## Arquivos

- Criar: `apps/dispatch-worker/src/ses-client.ts`
- Criar: `apps/dispatch-worker/src/kafka.ts`
- Criar: `apps/dispatch-worker/src/consumer.ts`
- Criar: `apps/dispatch-worker/src/index.ts`
- Modificar: `apps/dispatch-worker/package.json` (adicionar `kafkajs`, `@aws-sdk/client-ses`, `@ruguin/event-schemas`)
- Teste: `apps/dispatch-worker/test/consumer.test.ts`

## Interfaces

- **Consome:** `tryAcquireToken`/`createRedis` (Task 9); `TOPICS`, `EmailSendRequestedSchema`, `EmailStatusUpdatedSchema` de `@ruguin/event-schemas` (Task 3); o Kafka e o LocalStack rodando da Task 2.
- **Produz:** `runConsumer(opts: RunConsumerOptions): Promise<void>` — o loop principal do worker, exercitado diretamente pelo teste ponta a ponta da Task 11 (iniciado uma vez, junto com o API Service).

## Passos

1. **Adicionar dependências em `apps/dispatch-worker/package.json`**

Adicionar em `"dependencies"`:
```json
"kafkajs": "^2.2.4",
"@aws-sdk/client-ses": "^3.669.0",
"@ruguin/event-schemas": "workspace:*"
```

Rodar `pnpm install` na raiz do repo depois de editar.

2. **Escrever o teste (deve falhar primeiro)**

`apps/dispatch-worker/test/consumer.test.ts`:
```ts
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Kafka } from 'kafkajs';
import { TOPICS, EmailStatusUpdatedSchema } from '@ruguin/event-schemas';
import { createRedis } from '../src/redis.js';
import { createSesClient } from '../src/ses-client.js';
import { createKafkaClient, createConsumer, createProducer } from '../src/kafka.js';
import { runConsumer } from '../src/consumer.js';

const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe('runConsumer', () => {
  it('consumes a send-requested event, calls SES, and publishes a "sent" status event', async () => {
    const redis = createRedis(redisUrl);
    const sesClient = createSesClient();
    const kafka = createKafkaClient(kafkaBrokers);
    const consumer = await createConsumer(kafka, `dispatch-worker-test-${Date.now()}`);
    const producer = await createProducer(kafka);

    void runConsumer({
      consumer,
      producer,
      redis,
      sesClient,
      rateLimitKey: `test:ses-rate-limit:${Date.now()}`,
      rateLimitCapacity: 10,
      rateLimitRefillPerSecond: 10,
    });

    // Wait for the consumer group to actually finish joining/rebalancing before publishing —
    // consumer.run() resolves as soon as the fetch loop is scheduled, not once partitions are
    // assigned, so a fixed sleep can flake under load.
    await new Promise<void>((resolve) => {
      consumer.on(consumer.events.GROUP_JOIN, () => resolve());
    });

    const emailId = randomUUID();
    const rawProducer = kafka.producer();
    await rawProducer.connect();
    await rawProducer.send({
      topic: TOPICS.EMAIL_SEND_REQUESTED,
      messages: [
        {
          key: emailId,
          value: JSON.stringify({
            emailId,
            orgId: randomUUID(),
            projectId: randomUUID(),
            from: 'sender@example.com',
            to: 'recipient@example.com',
            subject: 'Hello',
            html: '<p>Hi</p>',
            requestedAt: new Date().toISOString(),
          }),
        },
      ],
    });
    await rawProducer.disconnect();

    const statusConsumer = kafka.consumer({ groupId: `dispatch-worker-status-test-${Date.now()}` });
    await statusConsumer.connect();
    await statusConsumer.subscribe({ topic: TOPICS.EMAIL_STATUS_UPDATED, fromBeginning: true });

    const received = new Promise<unknown>((resolve) => {
      statusConsumer.run({
        eachMessage: async ({ message }) => {
          const parsed = JSON.parse(message.value?.toString() ?? '{}');
          if (parsed.emailId === emailId) resolve(parsed);
        },
      });
    });

    const event = EmailStatusUpdatedSchema.parse(await received);
    expect(event.status).toBe('sent');
    expect(event.sesMessageId).toBeTruthy();

    await statusConsumer.disconnect();
    await consumer.disconnect();
    await producer.disconnect();
    await redis.quit();
  }, 20000);

  afterAll(async () => {
    // no shared resources beyond what each test closes itself
  });
});
```

3. **Rodar o teste e confirmar que falha**

Rodar: `pnpm --filter @ruguin/dispatch-worker test`
Esperado: FAIL — `Cannot find module '../src/ses-client.js'` (e `kafka.js`, `consumer.js`).

4. **Implementar**

`apps/dispatch-worker/src/ses-client.ts`:
```ts
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

export function createSesClient(): SESClient {
  return new SESClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(client: SESClient, input: SendEmailInput): Promise<string> {
  const command = new SendEmailCommand({
    Source: input.from,
    Destination: { ToAddresses: [input.to] },
    Message: {
      Subject: { Data: input.subject },
      Body: { Html: { Data: input.html } },
    },
  });
  const result = await client.send(command);
  if (!result.MessageId) {
    throw new Error('SES did not return a MessageId');
  }
  return result.MessageId;
}
```

`apps/dispatch-worker/src/kafka.ts`:
```ts
import { Kafka, type Consumer, type Producer } from 'kafkajs';

export function createKafkaClient(brokers: string[]): Kafka {
  return new Kafka({ clientId: 'dispatch-worker', brokers });
}

export async function createConsumer(kafka: Kafka, groupId: string): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  return consumer;
}

export async function createProducer(kafka: Kafka): Promise<Producer> {
  const producer = kafka.producer();
  await producer.connect();
  return producer;
}
```

`apps/dispatch-worker/src/consumer.ts`:
```ts
import type { Consumer, Producer } from 'kafkajs';
import type Redis from 'ioredis';
import type { SESClient } from '@aws-sdk/client-ses';
import { EmailSendRequestedSchema, EmailStatusUpdatedSchema, TOPICS } from '@ruguin/event-schemas';
import { tryAcquireToken } from './rate-limiter.js';
import { sendEmail } from './ses-client.js';

export interface RunConsumerOptions {
  consumer: Consumer;
  producer: Producer;
  redis: Redis;
  sesClient: SESClient;
  rateLimitKey: string;
  rateLimitCapacity: number;
  rateLimitRefillPerSecond: number;
}

async function waitForToken(opts: RunConsumerOptions): Promise<boolean> {
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const acquired = await tryAcquireToken({
      redis: opts.redis,
      key: opts.rateLimitKey,
      capacity: opts.rateLimitCapacity,
      refillPerSecond: opts.rateLimitRefillPerSecond,
    });
    if (acquired) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function claimForProcessing(redis: Redis, emailId: string): Promise<boolean> {
  const result = await redis.set(`dispatch:processed:${emailId}`, '1', 'EX', 3600, 'NX');
  return result === 'OK';
}

export async function runConsumer(opts: RunConsumerOptions): Promise<void> {
  await opts.consumer.subscribe({ topic: TOPICS.EMAIL_SEND_REQUESTED, fromBeginning: false });

  await opts.consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;

      let event;
      try {
        event = EmailSendRequestedSchema.parse(JSON.parse(message.value.toString()));
      } catch (parseError) {
        // Malformed message — route to the DLQ and move on instead of crashing the loop and
        // reprocessing the same poison message forever.
        await opts.producer.send({
          topic: TOPICS.EMAIL_SEND_REQUESTED_DLQ,
          messages: [
            {
              value: message.value,
              headers: { 'x-dlq-reason': parseError instanceof Error ? parseError.message : String(parseError) },
            },
          ],
        });
        return;
      }

      const claimed = await claimForProcessing(opts.redis, event.emailId);
      if (!claimed) {
        // Kafka's at-least-once delivery redelivered an emailId we already attempted — skip to
        // avoid sending the same email twice through SES.
        return;
      }

      const acquired = await waitForToken(opts);

      let statusEvent;
      if (!acquired) {
        statusEvent = EmailStatusUpdatedSchema.parse({
          emailId: event.emailId,
          status: 'failed',
          errorMessage: 'rate_limit_exceeded_timeout',
          occurredAt: new Date().toISOString(),
        });
      } else {
        try {
          const sesMessageId = await sendEmail(opts.sesClient, {
            from: event.from,
            to: event.to,
            subject: event.subject,
            html: event.html,
          });
          statusEvent = EmailStatusUpdatedSchema.parse({
            emailId: event.emailId,
            status: 'sent',
            sesMessageId,
            occurredAt: new Date().toISOString(),
          });
        } catch (error) {
          statusEvent = EmailStatusUpdatedSchema.parse({
            emailId: event.emailId,
            status: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            occurredAt: new Date().toISOString(),
          });
        }
      }

      await opts.producer.send({
        topic: TOPICS.EMAIL_STATUS_UPDATED,
        messages: [{ key: statusEvent.emailId, value: JSON.stringify(statusEvent) }],
      });
    },
  });
}
```

> **Por que a mensagem malformada vai para uma DLQ em vez de lançar exceção:** se `EmailSendRequestedSchema.parse` lançasse sem ser capturado, o KafkaJS trataria isso como falha do handler — o offset nunca seria commitado, e na próxima poll a mesma mensagem seria entregue de novo, travando a partição inteira num loop infinito de reprocessamento ("poison message"). Capturar o erro, publicar em `EMAIL_SEND_REQUESTED_DLQ` e retornar normalmente deixa o offset avançar.
>
> **Por que o `claimForProcessing` antes de chamar a SES:** Kafka garante entrega "pelo menos uma vez" — se o worker cair depois de enviar o email mas antes de commitar o offset (ou antes de publicar o evento de status), a mesma mensagem é reentregue e, sem essa trava, o mesmo email seria enviado duas vezes pela SES. `SET ... NX` no Redis é atômico: só a primeira tentativa "ganha" a chave; tentativas seguintes para o mesmo `emailId` são identificadas como redelivery e ignoradas.
>
> **O que fica de fora, deliberadamente:** isso cobre proteção contra mensagem malformada (DLQ) e contra reenvio duplicado (dedup), mas não implementa retry com backoff exponencial para falhas transitórias da própria SES — hoje uma falha da chamada `sendEmail` é reportada uma única vez como `status: failed`. Retry com backoff fica para um hardening futuro; ver a nota em Restrições Globais.

`apps/dispatch-worker/src/index.ts`:
```ts
import { createRedis } from './redis.js';
import { createSesClient } from './ses-client.js';
import { createKafkaClient, createConsumer, createProducer } from './kafka.js';
import { runConsumer } from './consumer.js';

async function main() {
  const redis = createRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sesClient = createSesClient();
  const kafka = createKafkaClient((process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','));
  const consumer = await createConsumer(kafka, 'dispatch-worker');
  const producer = await createProducer(kafka);

  await runConsumer({
    consumer,
    producer,
    redis,
    sesClient,
    rateLimitKey: 'ses:rate-limit',
    rateLimitCapacity: Number(process.env.SES_RATE_CAPACITY ?? 14),
    rateLimitRefillPerSecond: Number(process.env.SES_RATE_REFILL_PER_SECOND ?? 14),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

5. **Rodar o teste e confirmar que passa**

Rodar: `pnpm --filter @ruguin/dispatch-worker test`
Esperado: PASS. (A emulação de SES do LocalStack aceita envios sem as restrições de sandbox/identidade verificada que a AWS SES real exige, então nenhum passo de verificação é necessário para este teste.)

6. **Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): consume email.send.requested, call SES, publish status"
```

## Nota para quem for fazer a Task 11

A Task 11 precisa importar `createRedis`, `createSesClient`, `createKafkaClient`, `createConsumer`, `createProducer` e `runConsumer` de fora deste pacote (`@ruguin/dispatch-worker`). Como `src/index.ts` é o entrypoint executável (tem `main().catch(...)` no topo), a Task 11 cria um `src/lib.ts` separado só com os re-exports e aponta o `"main"`/`"types"` do `package.json` para ele — isso está detalhado no brief da Task 11, não precisa fazer nada disso agora.

Lembrete válido a partir da Task 11 em diante: se você editar qualquer arquivo em `apps/dispatch-worker/src/`, rode `pnpm --filter @ruguin/dispatch-worker build` de novo antes de rodar os testes do `@ruguin/api-service` — como o e2e importa o pacote pelo `dist/lib.js` já compilado (não pelo `src/` direto), um `dist/` desatualizado faz o teste e2e silenciosamente exercitar código antigo do worker.
