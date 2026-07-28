# Task 7: API Service — Kafka producer + template rendering

**Depende de:** Task 2 (Kafka rodando), Task 3 (`@ruguin/event-schemas`), Task 6 (auth/app.ts)
**Próximas tasks que dependem desta:** 8, 11

## Contexto

As duas últimas peças que faltam antes da rota de envio (Task 8): um producer Kafka conectado (decorado no app Fastify) e a função que resolve `{{variavel}}` dentro de um template — usada para renderizar `subject`/`html` antes de publicar o evento.

## Arquivos

- Criar: `apps/api-service/src/kafka.ts`
- Criar: `apps/api-service/src/templates/render.ts`
- Modificar: `apps/api-service/src/app.ts` (adicionar decorator `kafkaProducer`)
- Modificar: `apps/api-service/package.json` (adicionar `kafkajs`, `@ruguin/event-schemas`)
- Teste: `apps/api-service/test/templates/render.test.ts`
- Teste: `apps/api-service/test/kafka.test.ts`

## Interfaces

- **Consome:** `TOPICS` de `@ruguin/event-schemas` (Task 3); o Kafka rodando da Task 2.
- **Produz:** `renderTemplate(template: string, variables: Record<string, string>): string` (usada pela Task 8); `createKafkaProducer(brokers: string[]): Promise<Producer>` e o decorator `app.kafkaProducer: Producer` (usado pela Task 8 para publicar `email.send.requested`).

## Passos

1. **Adicionar dependências em `apps/api-service/package.json`**

Adicionar em `"dependencies"`:
```json
"kafkajs": "^2.2.4",
"@ruguin/event-schemas": "workspace:*"
```

Rodar `pnpm install` na raiz do repo depois de editar. (Confirme que a Task 3 já foi buildada — rode `pnpm --filter @ruguin/event-schemas build` se `dist/` estiver faltando.)

2. **Escrever os testes (devem falhar primeiro)**

`apps/api-service/test/templates/render.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../src/templates/render.js';

describe('renderTemplate', () => {
  it('substitutes known variables', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'Ada' })).toBe('Hello Ada!');
  });

  it('throws on a missing variable', () => {
    expect(() => renderTemplate('Hello {{name}}!', {})).toThrow('Missing template variable: name');
  });
});
```

`apps/api-service/test/kafka.test.ts`:
```ts
import { describe, it, expect, afterAll } from 'vitest';
import { Kafka } from 'kafkajs';
import { createKafkaProducer } from '../src/kafka.js';
import { TOPICS } from '@ruguin/event-schemas';

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');

describe('createKafkaProducer', () => {
  it('connects and can publish a message that a consumer receives', async () => {
    const producer = await createKafkaProducer(brokers);

    const kafka = new Kafka({ clientId: 'kafka-test-consumer', brokers });
    const consumer = kafka.consumer({ groupId: `kafka-test-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPICS.EMAIL_SEND_REQUESTED, fromBeginning: false });

    const received = new Promise<string>((resolve) => {
      consumer.run({
        eachMessage: async ({ message }) => {
          resolve(message.value?.toString() ?? '');
        },
      });
    });

    await producer.send({ topic: TOPICS.EMAIL_SEND_REQUESTED, messages: [{ value: 'ping' }] });
    await expect(received).resolves.toBe('ping');

    await consumer.disconnect();
    await producer.disconnect();
  }, 15000);
});
```

3. **Rodar os testes e confirmar que falham**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: FAIL — `Cannot find module '../../src/templates/render.js'` e `'../src/kafka.js'`.

4. **Implementar**

`apps/api-service/src/templates/render.ts`:
```ts
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(variables, key)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return variables[key];
  });
}
```

> **Por que `Object.hasOwn` e não `in`:** o operador `in` também enxerga propriedades herdadas do protótipo (`toString`, `constructor`, etc). Um template com `{{toString}}` resolveria silenciosamente para a função `Object.prototype.toString` em vez de lançar o erro esperado de variável faltando — `variables` vem de texto de template potencialmente controlado pelo cliente da API, então essa checagem precisa ser estrita a propriedades próprias do objeto.

`apps/api-service/src/kafka.ts`:
```ts
import { Kafka, type Producer } from 'kafkajs';

export async function createKafkaProducer(brokers: string[]): Promise<Producer> {
  const kafka = new Kafka({ clientId: 'api-service', brokers });
  const producer = kafka.producer();
  await producer.connect();
  return producer;
}
```

Modificar `apps/api-service/src/app.ts` — adicionar o import e o decorator:
```ts
import type { Producer } from 'kafkajs';
import { createKafkaProducer } from './kafka.js';
```
```ts
declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    redis: Redis;
    kafkaProducer: Producer;
  }
}

export interface BuildAppOptions {
  databaseUrl: string;
  redisUrl: string;
  kafkaBrokers: string[];
}
```
```ts
  app.decorate('db', createDb(opts.databaseUrl));
  app.decorate('redis', createRedis(opts.redisUrl));
  app.decorate('kafkaProducer', await createKafkaProducer(opts.kafkaBrokers));
  app.addHook('onClose', async () => {
    await app.kafkaProducer.disconnect();
  });
```

`kafkaBrokers` passa a ser obrigatório — atualize os testes das Tasks 4/6 e o `server.ts` para passar `kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')`.

5. **Rodar os testes e confirmar que passam**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: PASS.

6. **Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): add Kafka producer and template rendering"
```
