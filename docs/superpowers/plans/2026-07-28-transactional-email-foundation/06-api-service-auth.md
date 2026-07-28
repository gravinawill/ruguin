# Task 6: API Service — Redis client + API-key auth plugin

**Depende de:** Task 2 (Redis rodando), Task 5 (schema/DB do API Service)
**Próximas tasks que dependem desta:** 7, 8, 11

## Contexto

Toda chamada autenticada da API passa por aqui: hash da API key, lookup no Postgres (`api_keys` + `projects`), cache no Redis por 5 minutos para não bater no banco a cada request. É o mecanismo de multi-tenancy — resolve qual `projectId`/`orgId` está fazendo a chamada.

## Arquivos

- Criar: `apps/api-service/src/redis.ts`
- Criar: `apps/api-service/src/plugins/auth.ts`
- Modificar: `apps/api-service/src/app.ts` (registrar os decorators `db`, `redis` e o `authPlugin`)
- Modificar: `apps/api-service/package.json` (adicionar `ioredis`, `fastify-plugin`)
- Teste: `apps/api-service/test/plugins/auth.test.ts`

## Interfaces

- **Consome:** `createDb`/`Db` e as tabelas `apiKeys`/`projects` da Task 5; o Redis rodando da Task 2.
- **Produz:** `hashApiKey(rawKey: string): string`; um decorator Fastify `app.authenticate: (request, reply) => Promise<void>` usável como `preHandler` em qualquer rota (usado pela Task 8 em `POST /emails`); `request.auth: { projectId: string; orgId: string } | undefined` setado após autenticação bem-sucedida. `buildApp` passa a exigir `databaseUrl` e `redisUrl`.

## Passos

1. **Adicionar dependências em `apps/api-service/package.json`**

Adicionar em `"dependencies"`:
```json
"ioredis": "^5.4.1",
"fastify-plugin": "^5.0.1"
```

Rodar `pnpm install` na raiz do repo depois de editar.

2. **Escrever o teste (deve falhar primeiro)**

`apps/api-service/test/plugins/auth.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { createDb } from '../../src/db/client.js';
import { orgs, projects, apiKeys } from '../../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://ruguin:ruguin@localhost:5432/ruguin';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const db = createDb(databaseUrl);

const RAW_KEY = 'test-raw-key-12345';

describe('authenticate', () => {
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    const [org] = await db.insert(orgs).values({ name: 'Auth Test Org' }).returning();
    orgId = org.id;
    const [project] = await db.insert(projects).values({ orgId: org.id, name: 'Auth Test Project' }).returning();
    projectId = project.id;
    const hashedKey = createHash('sha256').update(RAW_KEY).digest('hex');
    await db.insert(apiKeys).values({ projectId, hashedKey });
  });

  afterAll(async () => {
    await db.delete(apiKeys).where(eq(apiKeys.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.$client.end();
  });

  it('rejects requests with no Authorization header', async () => {
    const app = await buildApp({ databaseUrl, redisUrl });
    app.get('/protected', { preHandler: app.authenticate }, async () => ({ ok: true }));
    const response = await app.inject({ method: 'GET', url: '/protected' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('accepts a valid API key and attaches request.auth', async () => {
    const app = await buildApp({ databaseUrl, redisUrl });
    app.get('/protected', { preHandler: app.authenticate }, async (request) => request.auth);
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${RAW_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ projectId });
    await app.close();
  });

  it('rejects an unknown API key', async () => {
    const app = await buildApp({ databaseUrl, redisUrl });
    app.get('/protected', { preHandler: app.authenticate }, async () => ({ ok: true }));
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not-a-real-key' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
```

3. **Rodar o teste e confirmar que falha**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: FAIL — `Cannot find module '../../src/plugins/auth.js'` (e `app.authenticate` não existe).

4. **Implementar o client Redis e o plugin de auth, conectar no `app.ts`**

`apps/api-service/src/redis.ts`:
```ts
import Redis from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url);
}
```

`apps/api-service/src/plugins/auth.ts`:
```ts
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apiKeys, projects } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    auth?: { projectId: string; orgId: string };
  }
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorateRequest('auth', undefined);

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing_api_key' });
    }
    const rawKey = header.slice('Bearer '.length);
    const hashed = hashApiKey(rawKey);
    const cacheKey = `apikey:${hashed}`;

    const cached = await app.redis.get(cacheKey);
    if (cached) {
      request.auth = JSON.parse(cached);
      return;
    }

    const rows = await app.db
      .select({ projectId: apiKeys.projectId, orgId: projects.orgId, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .innerJoin(projects, eq(apiKeys.projectId, projects.id))
      .where(eq(apiKeys.hashedKey, hashed))
      .limit(1);

    const row = rows[0];
    if (!row || row.revokedAt) {
      return reply.code(401).send({ error: 'invalid_api_key' });
    }

    const auth = { projectId: row.projectId, orgId: row.orgId };
    request.auth = auth;
    await app.redis.set(cacheKey, JSON.stringify(auth), 'EX', 300);
  });
});

export default authPlugin;
```

Modificar `apps/api-service/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { createDb, type Db } from './db/client.js';
import { createRedis } from './redis.js';
import authPlugin from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    redis: Redis;
  }
}

export interface BuildAppOptions {
  databaseUrl: string;
  redisUrl: string;
  kafkaBrokers?: string[];
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.decorate('db', createDb(opts.databaseUrl));
  app.decorate('redis', createRedis(opts.redisUrl));
  app.addHook('onClose', async () => {
    await app.redis.quit();
  });
  app.addHook('onClose', async () => {
    await app.db.$client.end();
  });

  await app.register(authPlugin);
  await app.register(healthRoutes);

  return app;
}
```

> **Por que os `onClose` hooks:** `app.close()` do Fastify só derruba o próprio servidor e seus plugins — ele não sabe que `db` e `redis` são conexões externas decoradas manualmente. Sem isso, cada `buildApp()` chamado num teste abre uma conexão nova com Postgres/Redis que nunca é liberada, e a suíte de testes (que cria um app novo por `it`) acumula conexões até travar ou vazar. `app.addHook('onClose', ...)` é o jeito documentado do Fastify de amarrar o ciclo de vida de um recurso externo ao do app.

`databaseUrl`/`redisUrl` agora são obrigatórios — atualize a chamada de `buildApp` no teste da Task 4 (`health.test.ts`):
```ts
const app = await buildApp({
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ruguin:ruguin@localhost:5432/ruguin',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
});
```

5. **Rodar os testes e confirmar que passam**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: PASS (teste de health + 3 testes de auth).

6. **Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): add Redis client and API-key auth plugin"
```
