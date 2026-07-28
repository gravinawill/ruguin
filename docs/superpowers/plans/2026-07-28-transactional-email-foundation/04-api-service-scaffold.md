# Task 4: API Service — project scaffold + health route

**Depende de:** Task 1 (monorepo scaffolding)
**Próximas tasks que dependem desta:** 5, 6, 7, 8, 11

## Contexto

Primeiro esqueleto do API Service: um app Fastify testável via `buildApp()` (fábrica separada do `server.ts` que sobe a porta), com uma única rota de health check. Toda peça futura do API Service (DB, Redis, Kafka, rotas) se registra dentro dessa fábrica.

## Arquivos

- Criar: `apps/api-service/package.json`
- Criar: `apps/api-service/tsconfig.json`
- Criar: `apps/api-service/src/routes/health.ts`
- Criar: `apps/api-service/src/app.ts`
- Criar: `apps/api-service/src/server.ts`
- Teste: `apps/api-service/test/routes/health.test.ts`

## Interfaces

- **Consome:** nada de outras tasks ainda.
- **Produz:** `buildApp(opts: BuildAppOptions): Promise<FastifyInstance>` — a fábrica de app que toda task seguinte do API Service (5, 6, 7, 8) estende. `BuildAppOptions` hoje não tem campos obrigatórios; tasks seguintes adicionam `databaseUrl`, `redisUrl`, `kafkaBrokers`.

## Passos

1. **Criar `apps/api-service/package.json`**

```json
{
  "name": "@ruguin/api-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

2. **Criar `apps/api-service/tsconfig.json`**

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

3. **Escrever o teste (deve falhar primeiro)**

`apps/api-service/test/routes/health.test.ts`:
```ts
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = await buildApp({});
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
```

4. **Rodar o teste e confirmar que falha**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: FAIL — `Cannot find module '../../src/app.js'`.

5. **Implementar a fábrica do app, a rota de health e o entrypoint do servidor**

`apps/api-service/src/routes/health.ts`:
```ts
import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok' }));
};
```

`apps/api-service/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from './routes/health.js';

export interface BuildAppOptions {
  databaseUrl?: string;
  redisUrl?: string;
  kafkaBrokers?: string[];
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(healthRoutes);

  return app;
}
```

`apps/api-service/src/server.ts`:
```ts
import { buildApp } from './app.js';

async function main() {
  const app = await buildApp({
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  });

  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

6. **Rodar o teste e confirmar que passa**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: PASS.

7. **Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): scaffold Fastify app with health route"
```

## Nota para quem for fazer a Task 6

A Task 6 torna `databaseUrl` e `redisUrl` obrigatórios em `BuildAppOptions` — o teste desta task (`health.test.ts`) vai precisar ser atualizado para passar esses campos quando isso acontecer. Não é necessário fazer isso agora, só um aviso do que vem pela frente.
