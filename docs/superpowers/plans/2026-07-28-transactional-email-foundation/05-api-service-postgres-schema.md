# Task 5: API Service — Postgres schema + Drizzle client + migrations

**Depende de:** Task 2 (Postgres rodando), Task 4 (scaffold do API Service)
**Próximas tasks que dependem desta:** 6, 7, 8, 11

## Contexto

Modela as tabelas que o API Service possui como fonte de verdade: `orgs`, `projects`, `api_keys`, `templates`, `emails`. Este é o único schema Postgres do API Service — nenhum outro serviço lê essas tabelas diretamente (comunicação entre serviços é só via Kafka).

## Arquivos

- Criar: `apps/api-service/src/db/schema.ts`
- Criar: `apps/api-service/src/db/client.ts`
- Criar: `apps/api-service/src/db/migrate.ts`
- Criar: `apps/api-service/drizzle.config.ts`
- Modificar: `apps/api-service/package.json` (adicionar `drizzle-orm`, `pg`, `drizzle-kit`, scripts `db:generate`/`db:migrate`)
- Teste: `apps/api-service/test/db/schema.test.ts`

## Interfaces

- **Consome:** o Postgres rodando da Task 2 (`postgres://ruguin:ruguin@localhost:5432/ruguin`).
- **Produz:** `createDb(connectionString: string): Db` e `type Db`, mais as tabelas Drizzle `orgs`, `projects`, `apiKeys`, `templates`, `emails` — importadas pelas Tasks 6, 7, 8 (`import { createDb, type Db } from '../db/client.js'` e `import { apiKeys, projects, templates, emails } from '../db/schema.js'`).

## Passos

1. **Adicionar dependências e scripts em `apps/api-service/package.json`**

Adicionar em `"dependencies"`:
```json
"drizzle-orm": "^0.36.0",
"pg": "^8.13.0"
```

Adicionar em `"devDependencies"`:
```json
"@types/pg": "^8.11.10",
"drizzle-kit": "^0.26.2"
```

Adicionar em `"scripts"`:
```json
"db:generate": "drizzle-kit generate",
"db:migrate": "tsx src/db/migrate.ts"
```

Rodar `pnpm install` na raiz do repo depois de editar.

2. **Escrever o teste (deve falhar primeiro)**

`apps/api-service/test/db/schema.test.ts`:
```ts
import { describe, it, expect, afterAll } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { orgs, projects } from '../../src/db/schema.js';

const db = createDb(process.env.DATABASE_URL ?? 'postgres://ruguin:ruguin@localhost:5432/ruguin');

describe('db schema', () => {
  it('inserts an org and a project referencing it', async () => {
    const [org] = await db.insert(orgs).values({ name: 'Test Org' }).returning();
    const [project] = await db.insert(projects).values({ orgId: org.id, name: 'Test Project' }).returning();

    expect(project.orgId).toBe(org.id);
  });

  afterAll(async () => {
    await db.$client.end();
  });
});
```

3. **Rodar o teste e confirmar que falha**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: FAIL — `Cannot find module '../../src/db/client.js'`.

4. **Implementar o schema e o client**

`apps/api-service/src/db/schema.ts`:
```ts
import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  hashedKey: text('hashed_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const templates = pgTable('templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  html: text('html').notNull(),
  text: text('text'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emails = pgTable('emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  templateId: uuid('template_id').references(() => templates.id),
  fromAddress: text('from_address').notNull(),
  toAddress: text('to_address').notNull(),
  subject: text('subject').notNull(),
  html: text('html').notNull(),
  status: text('status').notNull().default('queued'),
  idempotencyKey: text('idempotency_key'),
  sesMessageId: text('ses_message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  projectIdempotencyUnique: unique().on(table.projectId, table.idempotencyKey),
}));
```

`apps/api-service/src/db/client.ts`:
```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
```

`apps/api-service/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://ruguin:ruguin@localhost:5432/ruguin',
  },
});
```

`apps/api-service/src/db/migrate.ts`:
```ts
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

async function main() {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://ruguin:ruguin@localhost:5432/ruguin');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

5. **Gerar e aplicar a migration**

Rodar:
```bash
pnpm --filter @ruguin/api-service run db:generate
pnpm --filter @ruguin/api-service run db:migrate
```
Esperado: aparece um arquivo SQL em `apps/api-service/drizzle/`, e `db:migrate` imprime `Migrations applied`.

6. **Rodar o teste e confirmar que passa**

Rodar: `pnpm --filter @ruguin/api-service test`
Esperado: PASS.

7. **Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): add Postgres schema, Drizzle client, and migrations"
```
