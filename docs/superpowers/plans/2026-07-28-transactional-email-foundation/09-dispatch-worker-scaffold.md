# Task 9: Dispatch Worker — scaffold + Redis token-bucket rate limiter

**Depende de:** Task 1 (monorepo scaffolding), Task 2 (Redis rodando)
**Próximas tasks que dependem desta:** 10, 11

## Contexto

Primeiro esqueleto do Dispatch Worker, começando pelo rate limiter que protege a conta AWS SES contra estourar o limite de requisições/segundo — implementado como token bucket atômico via script Lua no Redis (evita condições de corrida entre chamadas concorrentes).

## Arquivos

- Criar: `apps/dispatch-worker/package.json`
- Criar: `apps/dispatch-worker/tsconfig.json`
- Criar: `apps/dispatch-worker/src/redis.ts`
- Criar: `apps/dispatch-worker/src/rate-limiter.ts`
- Teste: `apps/dispatch-worker/test/rate-limiter.test.ts`

## Interfaces

- **Consome:** o Redis rodando da Task 2.
- **Produz:** `tryAcquireToken(opts: { redis: Redis; key: string; capacity: number; refillPerSecond: number }): Promise<boolean>` e `createRedis(url: string): Redis` — usados pelo consumer da Task 10.

## Passos

1. **Criar `apps/dispatch-worker/package.json`**

```json
{
  "name": "@ruguin/dispatch-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "ioredis": "^5.4.1"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

2. **Criar `apps/dispatch-worker/tsconfig.json`**

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

`apps/dispatch-worker/test/rate-limiter.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRedis } from '../src/redis.js';
import { tryAcquireToken } from '../src/rate-limiter.js';

const redis = createRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');

describe('tryAcquireToken', () => {
  beforeEach(async () => {
    await redis.del('test:rate-limit');
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('allows up to capacity requests then blocks when refill is zero', async () => {
    const opts = { redis, key: 'test:rate-limit', capacity: 2, refillPerSecond: 0 };
    expect(await tryAcquireToken(opts)).toBe(true);
    expect(await tryAcquireToken(opts)).toBe(true);
    expect(await tryAcquireToken(opts)).toBe(false);
  });

  it('refills over time', async () => {
    const opts = { redis, key: 'test:rate-limit', capacity: 1, refillPerSecond: 10 };
    expect(await tryAcquireToken(opts)).toBe(true);
    expect(await tryAcquireToken(opts)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await tryAcquireToken(opts)).toBe(true);
  });
});
```

4. **Rodar o teste e confirmar que falha**

Rodar: `pnpm --filter @ruguin/dispatch-worker test`
Esperado: FAIL — `Cannot find module '../src/redis.js'`.

5. **Implementar**

`apps/dispatch-worker/src/redis.ts`:
```ts
import Redis from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url);
}
```

`apps/dispatch-worker/src/rate-limiter.ts`:
```ts
import type Redis from 'ioredis';

export interface RateLimiterOptions {
  redis: Redis;
  key: string;
  capacity: number;
  refillPerSecond: number;
}

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSecond = tonumber(ARGV[2])

local time = redis.call('TIME')
local now = tonumber(time[1]) + (tonumber(time[2]) / 1000000)

local bucket = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens = tonumber(bucket[1])
local updatedAt = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  updatedAt = now
end

local elapsed = math.max(0, now - updatedAt)
tokens = math.min(capacity, tokens + elapsed * refillPerSecond)

if tokens < 1 then
  redis.call('HSET', key, 'tokens', tokens, 'updatedAt', now)
  redis.call('EXPIRE', key, 3600)
  return 0
end

tokens = tokens - 1
redis.call('HSET', key, 'tokens', tokens, 'updatedAt', now)
redis.call('EXPIRE', key, 3600)
return 1
`;

export async function tryAcquireToken(opts: RateLimiterOptions): Promise<boolean> {
  const result = await opts.redis.eval(TOKEN_BUCKET_SCRIPT, 1, opts.key, opts.capacity, opts.refillPerSecond);
  return result === 1;
}
```

> **Por que o horário vem do `TIME` do Redis, não de `Date.now()` no cliente:** o script Lua é atômico dentro do Redis, mas se cada instância do Dispatch Worker calculasse `now` com o próprio relógio, um desvio de relógio (clock skew) entre instâncias faria uma delas parecer reabastecer mais rápido que a outra — ou, se o relógio de uma instância voltasse no tempo (correção de NTP), `elapsed` cairia para 0 e ela pararia de reabastecer até o relógio se alinhar de novo. Como o rate limit é compartilhado entre todas as instâncias do worker (protegendo o limite único da conta SES), usar o relógio do próprio Redis elimina essa dependência de sincronização entre processos.

6. **Rodar o teste e confirmar que passa**

Rodar: `pnpm --filter @ruguin/dispatch-worker test`
Esperado: PASS.

7. **Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): scaffold package and Redis token-bucket rate limiter"
```
