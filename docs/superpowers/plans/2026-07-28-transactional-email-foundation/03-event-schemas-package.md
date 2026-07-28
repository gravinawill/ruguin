# Task 3: Shared event-schemas package

**Depende de:** Task 1 (monorepo scaffolding)
**Próximas tasks que dependem desta:** 7, 8, 10, 11 (qualquer código que produz/consome eventos Kafka)

## Contexto

Este pacote (`packages/event-schemas`) é o contrato entre produtores e consumidores de eventos Kafka: nomes de tópicos e schemas Zod dos payloads. Como API Service e Dispatch Worker importam do mesmo lugar, uma mudança que quebra o contrato quebra a build de quem depende dela — não o comportamento em produção.

## Arquivos

- Criar: `packages/event-schemas/package.json`
- Criar: `packages/event-schemas/tsconfig.json`
- Criar: `packages/event-schemas/src/topics.ts`
- Criar: `packages/event-schemas/src/email-send-requested.ts`
- Criar: `packages/event-schemas/src/email-status-updated.ts`
- Criar: `packages/event-schemas/src/index.ts`
- Teste: `packages/event-schemas/test/email-send-requested.test.ts`
- Teste: `packages/event-schemas/test/email-status-updated.test.ts`

## Interfaces

- **Produz** (consumido por toda task seguinte que mexe com Kafka): `TOPICS.EMAIL_SEND_REQUESTED`, `TOPICS.EMAIL_STATUS_UPDATED`, `TOPICS.EMAIL_ENGAGEMENT` (constantes string); `EmailSendRequestedSchema: ZodSchema<EmailSendRequested>` e o tipo inferido `EmailSendRequested`; `EmailStatusUpdatedSchema: ZodSchema<EmailStatusUpdated>` e o tipo inferido `EmailStatusUpdated`. Tudo exportado de `@ruguin/event-schemas`.

## Passos

1. **Criar `packages/event-schemas/package.json`**

```json
{
  "name": "@ruguin/event-schemas",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

2. **Criar `packages/event-schemas/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

3. **Escrever os testes (devem falhar primeiro)**

`packages/event-schemas/test/email-send-requested.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EmailSendRequestedSchema } from '../src/email-send-requested.js';

describe('EmailSendRequestedSchema', () => {
  it('accepts a valid payload', () => {
    const result = EmailSendRequestedSchema.safeParse({
      emailId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      orgId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      projectId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
      requestedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid email address', () => {
    const result = EmailSendRequestedSchema.safeParse({
      emailId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      orgId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      projectId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      from: 'not-an-email',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
      requestedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
```

`packages/event-schemas/test/email-status-updated.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EmailStatusUpdatedSchema } from '../src/email-status-updated.js';

describe('EmailStatusUpdatedSchema', () => {
  it('accepts a valid "sent" payload', () => {
    const result = EmailStatusUpdatedSchema.safeParse({
      emailId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      status: 'sent',
      sesMessageId: 'abc123',
      occurredAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const result = EmailStatusUpdatedSchema.safeParse({
      emailId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      status: 'not_a_real_status',
      occurredAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
```

4. **Rodar os testes e confirmar que falham**

Rodar: `pnpm --filter @ruguin/event-schemas test`
Esperado: FAIL — `Cannot find module '../src/email-send-requested.js'` (e o mesmo para o módulo de status), porque os arquivos de origem ainda não existem.

5. **Implementar os schemas**

`packages/event-schemas/src/topics.ts`:
```ts
export const TOPICS = {
  EMAIL_SEND_REQUESTED: 'email.send.requested',
  EMAIL_SEND_REQUESTED_DLQ: 'email.send.requested.dlq',
  EMAIL_STATUS_UPDATED: 'email.status.updated',
  EMAIL_STATUS_UPDATED_DLQ: 'email.status.updated.dlq',
  EMAIL_ENGAGEMENT: 'email.engagement',
  EMAIL_ENGAGEMENT_DLQ: 'email.engagement.dlq',
} as const;
```

> Cada tópico principal tem seu par `.dlq`, conforme a spec — Task 10 usa `EMAIL_SEND_REQUESTED_DLQ` para mensagens malformadas que não podem ser processadas (protege contra "poison message" travando a partição). Os outros pares `.dlq` ficam prontos para quando as tasks futuras (Webhook Ingestor, Tracking, etc.) precisarem deles.

`packages/event-schemas/src/email-send-requested.ts`:
```ts
import { z } from 'zod';

export const EmailSendRequestedSchema = z.object({
  emailId: z.string().uuid(),
  orgId: z.string().uuid(),
  projectId: z.string().uuid(),
  from: z.string().email(),
  to: z.string().email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().optional(),
  idempotencyKey: z.string().optional(),
  requestedAt: z.string().datetime(),
});

export type EmailSendRequested = z.infer<typeof EmailSendRequestedSchema>;
```

`packages/event-schemas/src/email-status-updated.ts`:
```ts
import { z } from 'zod';

export const EmailStatusUpdatedSchema = z.object({
  emailId: z.string().uuid(),
  status: z.enum(['sent', 'delivered', 'bounced', 'complained', 'failed']),
  sesMessageId: z.string().optional(),
  errorMessage: z.string().optional(),
  occurredAt: z.string().datetime(),
});

export type EmailStatusUpdated = z.infer<typeof EmailStatusUpdatedSchema>;
```

`packages/event-schemas/src/index.ts`:
```ts
export * from './topics.js';
export * from './email-send-requested.js';
export * from './email-status-updated.js';
```

> **Nota sobre `z.string().datetime()`:** no Zod 3.x, esse validador só aceita timestamps terminados em `Z` — offsets de fuso (`+02:00`) são rejeitados a menos que se use `.datetime({ offset: true })`. Todo produtor deste plano gera timestamps com `new Date().toISOString()`, que sempre emite `Z`, então está correto como está. Se algum serviço futuro formatar timestamps manualmente com offset, é aqui que vai quebrar.

6. **Rodar os testes e confirmar que passam**

Rodar: `pnpm --filter @ruguin/event-schemas test`
Esperado: PASS (4 testes).

7. **Buildar o pacote para que os serviços consigam consumi-lo**

Rodar: `pnpm --filter @ruguin/event-schemas build`
Esperado: são criados `packages/event-schemas/dist/index.js` e os `.d.ts`. (Toda task seguinte que depende de `@ruguin/event-schemas` precisa desse build existir — rode de novo se editar este pacote.)

8. **Commit**

```bash
git add packages/event-schemas
git commit -m "feat: add shared event-schemas package (EmailSendRequested, EmailStatusUpdated)"
```
