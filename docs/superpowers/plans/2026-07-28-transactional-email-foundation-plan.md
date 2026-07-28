# Transactional Email Foundation & Core Send Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, local dev infrastructure, and the two services that make up the core send path (API Service + Dispatch Worker), so an email sent via `POST /emails` is authenticated, persisted, published to Kafka, picked up by the Dispatch Worker, rate-limited, and actually sent through AWS SES (LocalStack in dev/test) — end to end, provably working.

**Architecture:** pnpm + Turborepo monorepo. Two Fastify/Node services (`apps/api-service`, `apps/dispatch-worker`) share a Zod-based event contract package (`packages/event-schemas`) and communicate only via Kafka. Postgres (API Service's own schema) is the source of truth for orgs/projects/api keys/templates/emails; Redis backs API-key auth caching and the Dispatch Worker's rate limiter.

**Tech Stack:** TypeScript (ESM, `NodeNext`), Node.js ≥20, Fastify 5, KafkaJS, Drizzle ORM + drizzle-kit, Zod, ioredis, `@aws-sdk/client-ses`, Vitest, Docker Compose (Kafka KRaft, Postgres, Redis, LocalStack), pnpm workspaces + Turborepo.

## Global Constraints

- Node.js ≥20, TypeScript ≥5.6, strict mode (`"strict": true`) everywhere.
- ESM only (`"type": "module"` in every package), relative imports use explicit `.js` extensions (required by `moduleResolution: NodeNext`).
- Package manager is pnpm (`packageManager: "pnpm@9.12.0"` in root `package.json`) — do not use npm/yarn commands.
- Every service owns its own Postgres schema/tables; no service queries another service's tables directly — cross-service communication is Kafka events only (per the approved design, `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`).
- Kafka topics are the constants exported from `@ruguin/event-schemas` (`packages/event-schemas`) — never hardcode topic name strings in application code.
- Integration tests run against the shared `docker-compose` dev stack (Postgres/Redis/Kafka/LocalStack) started via `docker compose up -d` at the repo root — not Testcontainers. Each test is responsible for cleaning up the rows/messages it creates. (Testcontainers-based full isolation is a deferred hardening item, out of scope for this plan.)
- **Scope note:** this plan does NOT include the SES Webhook Ingestor, Tracking Service, Webhook Notifier, or Read-Model Updater from the design doc — those are independently testable subsystems and belong in a follow-up plan. As a consequence, the `emails.status` column in Postgres stays `queued` after this plan; the proof that dispatch actually happened is the `email.status.updated` Kafka event, verified directly in Task 11's end-to-end test.
- **Scope note:** control-plane CRUD endpoints (creating/listing/updating orgs, projects, API keys, and templates) are also deferred to a follow-up plan. This plan's tests seed that data directly via Drizzle inserts (see Tasks 6, 8, 11) rather than through an API — `POST /emails` is the only route this plan exposes, alongside `GET /health`.
- **Scope note:** Task 10's Dispatch Worker consumer protects against a malformed message crashing the consume loop forever (routes it to `email.send.requested.dlq` instead) and against sending the same email twice on Kafka's at-least-once redelivery (a short-lived Redis claim per `emailId`). It does NOT implement exponential-backoff retry of transient SES failures before giving up — today a transient SES error is reported once as `status: failed`. That retry loop is deferred to a follow-up hardening pass; this is a deliberate scope cut, not an oversight.

---

## Task 1: Monorepo scaffolding

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`

**Interfaces:**
- Produces: the workspace root that every later task's `package.json` extends (`tsconfig.base.json` via `"extends"`) and runs inside (`pnpm --filter <name> <script>`, `turbo run <task>`).

- [ ] **Step 1: Create the root `package.json`**

```json
{
  "name": "ruguin",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.1.3",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {}
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
.turbo/
```

- [ ] **Step 6: Create `.env.example`**

```
DATABASE_URL=postgres://ruguin:ruguin@localhost:5432/ruguin
REDIS_URL=redis://localhost:6379
KAFKA_BROKERS=localhost:9092
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SES_FROM_ADDRESS=no-reply@example.com
```

- [ ] **Step 7: Verify the workspace installs cleanly**

Run: `pnpm install`
Expected: completes without error (there are no workspace packages yet, so it just links the root devDependencies — that's fine, this confirms `pnpm-workspace.yaml` and `package.json` are valid).

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .gitignore .env.example pnpm-lock.yaml
git commit -m "chore: scaffold pnpm + Turborepo monorepo"
```

---

## Task 2: Docker Compose dev infrastructure

**Files:**
- Create: `docker-compose.yml`

**Interfaces:**
- Produces: Postgres on `localhost:5432` (db/user/pass `ruguin`), Redis on `localhost:6379`, Kafka (KRaft, single broker) on `localhost:9092`, LocalStack (SES) on `localhost:4566` — every later task's integration tests connect to these fixed addresses (matching `.env.example` from Task 1).

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ruguin
      POSTGRES_PASSWORD: ruguin
      POSTGRES_DB: ruguin
    ports:
      - '5432:5432'
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ruguin']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10

  kafka:
    image: apache/kafka:3.8.0
    ports:
      - '9092:9092'
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1

  localstack:
    image: localstack/localstack:3
    ports:
      - '4566:4566'
    environment:
      SERVICES: ses
      DEFAULT_REGION: us-east-1
```

- [ ] **Step 2: Start the stack and verify health**

Run: `docker compose up -d && sleep 5 && docker compose ps`
Expected: all four services show as `running`/`healthy` (Kafka and LocalStack don't define healthchecks here, so just confirm `running`).

- [ ] **Step 3: Verify each service is actually reachable**

Run:
```bash
docker compose exec -T postgres pg_isready -U ruguin
docker compose exec -T redis redis-cli ping
docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
curl -s http://localhost:4566/_localstack/health | grep -o '"ses": "[a-z]*"'
```
Expected: `pg_isready` prints `accepting connections`, redis prints `PONG`, the Kafka topics command returns (empty list, no error), and the LocalStack health check shows `"ses": "available"`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: add docker-compose dev infra (postgres, redis, kafka, localstack)"
```

---

## Task 3: Shared event-schemas package

**Files:**
- Create: `packages/event-schemas/package.json`
- Create: `packages/event-schemas/tsconfig.json`
- Create: `packages/event-schemas/src/topics.ts`
- Create: `packages/event-schemas/src/email-send-requested.ts`
- Create: `packages/event-schemas/src/email-status-updated.ts`
- Create: `packages/event-schemas/src/index.ts`
- Test: `packages/event-schemas/test/email-send-requested.test.ts`
- Test: `packages/event-schemas/test/email-status-updated.test.ts`

**Interfaces:**
- Produces (consumed by every later task): `TOPICS.EMAIL_SEND_REQUESTED`, `TOPICS.EMAIL_STATUS_UPDATED`, `TOPICS.EMAIL_ENGAGEMENT` (string constants); `EmailSendRequestedSchema: ZodSchema<EmailSendRequested>` and its inferred type `EmailSendRequested`; `EmailStatusUpdatedSchema: ZodSchema<EmailStatusUpdated>` and its inferred type `EmailStatusUpdated`. All exported from `@ruguin/event-schemas`.

- [ ] **Step 1: Create `packages/event-schemas/package.json`**

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

- [ ] **Step 2: Create `packages/event-schemas/tsconfig.json`**

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

- [ ] **Step 3: Write the failing tests**

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

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @ruguin/event-schemas test`
Expected: FAIL — `Cannot find module '../src/email-send-requested.js'` (and same for the status module) because the source files don't exist yet.

- [ ] **Step 5: Implement the schemas**

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

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @ruguin/event-schemas test`
Expected: PASS (4 tests).

- [ ] **Step 7: Build the package so downstream services can consume it**

Run: `pnpm --filter @ruguin/event-schemas build`
Expected: `packages/event-schemas/dist/index.js` and `.d.ts` files are created. (Every later task that depends on `@ruguin/event-schemas` needs this build to exist — remember to rerun it if you edit this package.)

- [ ] **Step 8: Commit**

```bash
git add packages/event-schemas
git commit -m "feat: add shared event-schemas package (EmailSendRequested, EmailStatusUpdated)"
```

---

## Task 4: API Service — project scaffold + health route

**Files:**
- Create: `apps/api-service/package.json`
- Create: `apps/api-service/tsconfig.json`
- Create: `apps/api-service/src/routes/health.ts`
- Create: `apps/api-service/src/app.ts`
- Create: `apps/api-service/src/server.ts`
- Test: `apps/api-service/test/routes/health.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks yet.
- Produces: `buildApp(opts: BuildAppOptions): Promise<FastifyInstance>` — the app factory every later API Service task (5, 6, 7, 8) extends. `BuildAppOptions` currently has no required fields; later tasks add `databaseUrl`, `redisUrl`, `kafkaBrokers`.

- [ ] **Step 1: Create `apps/api-service/package.json`**

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

- [ ] **Step 2: Create `apps/api-service/tsconfig.json`**

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

- [ ] **Step 3: Write the failing test**

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

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @ruguin/api-service test`
Expected: FAIL — `Cannot find module '../../src/app.js'`.

- [ ] **Step 5: Implement the app factory, health route, and server entrypoint**

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

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @ruguin/api-service test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): scaffold Fastify app with health route"
```

---

## Task 5: API Service — Postgres schema + Drizzle client + migrations

**Files:**
- Create: `apps/api-service/src/db/schema.ts`
- Create: `apps/api-service/src/db/client.ts`
- Create: `apps/api-service/src/db/migrate.ts`
- Create: `apps/api-service/drizzle.config.ts`
- Modify: `apps/api-service/package.json` (add `drizzle-orm`, `pg`, `drizzle-kit`, `db:generate`/`db:migrate` scripts)
- Test: `apps/api-service/test/db/schema.test.ts`

**Interfaces:**
- Consumes: the running Postgres from Task 2 (`postgres://ruguin:ruguin@localhost:5432/ruguin`).
- Produces: `createDb(connectionString: string): Db` and `type Db`, plus Drizzle table objects `orgs`, `projects`, `apiKeys`, `templates`, `emails` — all imported by Tasks 6, 7, 8 (`import { createDb, type Db } from '../db/client.js'` and `import { apiKeys, projects, templates, emails } from '../db/schema.js'`).

- [ ] **Step 1: Add dependencies and scripts to `apps/api-service/package.json`**

Add to `"dependencies"`:
```json
"drizzle-orm": "^0.36.0",
"pg": "^8.13.0"
```

Add to `"devDependencies"`:
```json
"@types/pg": "^8.11.10",
"drizzle-kit": "^0.26.2"
```

Add to `"scripts"`:
```json
"db:generate": "drizzle-kit generate",
"db:migrate": "tsx src/db/migrate.ts"
```

Run `pnpm install` at the repo root after editing.

- [ ] **Step 2: Write the failing test**

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

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @ruguin/api-service test`
Expected: FAIL — `Cannot find module '../../src/db/client.js'`.

- [ ] **Step 4: Implement the schema and client**

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

- [ ] **Step 5: Generate and apply the migration**

Run:
```bash
pnpm --filter @ruguin/api-service run db:generate
pnpm --filter @ruguin/api-service run db:migrate
```
Expected: a SQL file appears under `apps/api-service/drizzle/`, and `db:migrate` prints `Migrations applied`.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @ruguin/api-service test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): add Postgres schema, Drizzle client, and migrations"
```

---

## Task 6: API Service — Redis client + API-key auth plugin

**Files:**
- Create: `apps/api-service/src/redis.ts`
- Create: `apps/api-service/src/plugins/auth.ts`
- Modify: `apps/api-service/src/app.ts` (wire up `db`, `redis` decorators, register `authPlugin`)
- Modify: `apps/api-service/package.json` (add `ioredis`, `fastify-plugin`)
- Test: `apps/api-service/test/plugins/auth.test.ts`

**Interfaces:**
- Consumes: `createDb`/`Db` and `apiKeys`/`projects` tables from Task 5; the running Redis from Task 2.
- Produces: `hashApiKey(rawKey: string): string`; a Fastify decorator `app.authenticate: (request, reply) => Promise<void>` usable as `preHandler` on any route (used by Task 8's `POST /emails`); `request.auth: { projectId: string; orgId: string } | undefined` set after successful authentication. `buildApp` now requires `databaseUrl` and `redisUrl`.

- [ ] **Step 1: Add dependencies to `apps/api-service/package.json`**

Add to `"dependencies"`:
```json
"ioredis": "^5.4.1",
"fastify-plugin": "^5.0.1"
```

Run `pnpm install` at the repo root after editing.

- [ ] **Step 2: Write the failing test**

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

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @ruguin/api-service test`
Expected: FAIL — `Cannot find module '../../src/plugins/auth.js'` (and `app.authenticate` doesn't exist).

- [ ] **Step 4: Implement Redis client and auth plugin, wire into `app.ts`**

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

Modify `apps/api-service/src/app.ts`:
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

Note: `BuildAppOptions.databaseUrl`/`redisUrl` are now required — Task 4's `health.test.ts` must be updated to pass them:
```ts
const app = await buildApp({
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ruguin:ruguin@localhost:5432/ruguin',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ruguin/api-service test`
Expected: PASS (health test + 3 auth tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): add Redis client and API-key auth plugin"
```

---

## Task 7: API Service — Kafka producer + template rendering

**Files:**
- Create: `apps/api-service/src/kafka.ts`
- Create: `apps/api-service/src/templates/render.ts`
- Modify: `apps/api-service/src/app.ts` (add `kafkaProducer` decorator)
- Modify: `apps/api-service/package.json` (add `kafkajs`, `@ruguin/event-schemas`)
- Test: `apps/api-service/test/templates/render.test.ts`
- Test: `apps/api-service/test/kafka.test.ts`

**Interfaces:**
- Consumes: `TOPICS` from `@ruguin/event-schemas` (Task 3); the running Kafka from Task 2.
- Produces: `renderTemplate(template: string, variables: Record<string, string>): string` (used by Task 8); `createKafkaProducer(brokers: string[]): Promise<Producer>` and `app.kafkaProducer: Producer` decorator (used by Task 8 to publish `email.send.requested`).

- [ ] **Step 1: Add dependencies to `apps/api-service/package.json`**

Add to `"dependencies"`:
```json
"kafkajs": "^2.2.4",
"@ruguin/event-schemas": "workspace:*"
```

Run `pnpm install` at the repo root after editing. (Confirms Task 3's package built with `dist/` — rerun `pnpm --filter @ruguin/event-schemas build` if it's missing.)

- [ ] **Step 2: Write the failing tests**

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

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @ruguin/api-service test`
Expected: FAIL — `Cannot find module '../../src/templates/render.js'` and `'../src/kafka.js'`.

- [ ] **Step 4: Implement**

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

Modify `apps/api-service/src/app.ts` — add the import and decorator:
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

Note: `kafkaBrokers` is now required — update Task 4/6's tests and `server.ts` call sites to pass `kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ruguin/api-service test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): add Kafka producer and template rendering"
```

---

## Task 8: API Service — `POST /emails` route (full send flow)

**Files:**
- Create: `apps/api-service/src/routes/emails.ts`
- Modify: `apps/api-service/src/app.ts` (register `emailsRoutes`)
- Test: `apps/api-service/test/routes/emails.test.ts`

**Interfaces:**
- Consumes: `app.authenticate` (Task 6), `app.db`/`emails`/`templates` (Task 5), `renderTemplate` (Task 7), `app.kafkaProducer` + `TOPICS.EMAIL_SEND_REQUESTED` + `EmailSendRequestedSchema` (Task 7 / `@ruguin/event-schemas`).
- Produces: `POST /emails` — the externally-visible API this whole plan exists to deliver. Response `202 { id: string, status: 'queued' }` on success; publishes a validated `EmailSendRequested` event keyed by `emailId`. Consumed by Task 10's Dispatch Worker and Task 11's end-to-end test.

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/api-service test`
Expected: FAIL — `404` (route doesn't exist yet) on the `POST /emails` calls.

- [ ] **Step 3: Implement the route**

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

Modify `apps/api-service/src/app.ts` — import and register:
```ts
import { emailsRoutes } from './routes/emails.js';
```
```ts
  await app.register(healthRoutes);
  await app.register(emailsRoutes);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ruguin/api-service test`
Expected: PASS (all API Service tests, including the three new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api-service
git commit -m "feat(api-service): add POST /emails send endpoint"
```

---

## Task 9: Dispatch Worker — scaffold + Redis token-bucket rate limiter

**Files:**
- Create: `apps/dispatch-worker/package.json`
- Create: `apps/dispatch-worker/tsconfig.json`
- Create: `apps/dispatch-worker/src/redis.ts`
- Create: `apps/dispatch-worker/src/rate-limiter.ts`
- Test: `apps/dispatch-worker/test/rate-limiter.test.ts`

**Interfaces:**
- Consumes: the running Redis from Task 2.
- Produces: `tryAcquireToken(opts: { redis: Redis; key: string; capacity: number; refillPerSecond: number }): Promise<boolean>` and `createRedis(url: string): Redis` — used by Task 10's consumer.

- [ ] **Step 1: Create `apps/dispatch-worker/package.json`**

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

- [ ] **Step 2: Create `apps/dispatch-worker/tsconfig.json`**

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

- [ ] **Step 3: Write the failing test**

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

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: FAIL — `Cannot find module '../src/redis.js'`.

- [ ] **Step 5: Implement**

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

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): scaffold package and Redis token-bucket rate limiter"
```

---

## Task 10: Dispatch Worker — SES client + Kafka consumer send flow

**Files:**
- Create: `apps/dispatch-worker/src/ses-client.ts`
- Create: `apps/dispatch-worker/src/kafka.ts`
- Create: `apps/dispatch-worker/src/consumer.ts`
- Create: `apps/dispatch-worker/src/index.ts`
- Modify: `apps/dispatch-worker/package.json` (add `kafkajs`, `@aws-sdk/client-ses`, `@ruguin/event-schemas`)
- Test: `apps/dispatch-worker/test/consumer.test.ts`

**Interfaces:**
- Consumes: `tryAcquireToken`/`createRedis` (Task 9); `TOPICS`, `EmailSendRequestedSchema`, `EmailStatusUpdatedSchema` from `@ruguin/event-schemas` (Task 3); the running Kafka and LocalStack from Task 2.
- Produces: `runConsumer(opts: RunConsumerOptions): Promise<void>` — the worker's main loop, exercised directly by Task 11's end-to-end test (started once, alongside the API Service).

- [ ] **Step 1: Add dependencies to `apps/dispatch-worker/package.json`**

Add to `"dependencies"`:
```json
"kafkajs": "^2.2.4",
"@aws-sdk/client-ses": "^3.669.0",
"@ruguin/event-schemas": "workspace:*"
```

Run `pnpm install` at the repo root after editing.

- [ ] **Step 2: Write the failing test**

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

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: FAIL — `Cannot find module '../src/ses-client.js'` (and `kafka.js`, `consumer.js`).

- [ ] **Step 4: Implement**

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

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: PASS. (LocalStack's SES emulation accepts sends without the sandbox/verified-identity restrictions real AWS SES enforces, so no verification step is needed for this test.)

- [ ] **Step 6: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): consume email.send.requested, call SES, publish status"
```

---

## Task 11: End-to-end smoke test across both services

**Files:**
- Test: `apps/api-service/test/e2e/send-email.e2e.test.ts`

**Interfaces:**
- Consumes: `buildApp` (Task 8, from `@ruguin/api-service`'s own `src/`), and `@ruguin/dispatch-worker`'s `createRedis`, `createSesClient`, `createKafkaClient`, `createConsumer`, `createProducer`, `runConsumer` (Task 10) — imported directly since this test lives conceptually "above" both services to prove the seam between them.
- Produces: nothing consumed further — this is the plan's final proof of "working, testable software."

- [ ] **Step 1: Add a dev dependency so the API Service test can import the Dispatch Worker's modules**

Add to `apps/api-service/package.json` `"devDependencies"`:
```json
"@ruguin/dispatch-worker": "workspace:*"
```

Run `pnpm install` at the repo root, then `pnpm --filter @ruguin/dispatch-worker build`.

- [ ] **Step 2: Write the end-to-end test**

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

Note: this test imports from `@ruguin/dispatch-worker`'s public entrypoint. Add an `apps/dispatch-worker/src/index.ts` re-export surface — since Task 10's `index.ts` is the executable entrypoint (has a top-level `main().catch(...)`), create a separate `apps/dispatch-worker/src/lib.ts` that re-exports the pieces this test needs, and point `package.json`'s `"main"`/`"types"` at its build output instead:

`apps/dispatch-worker/src/lib.ts`:
```ts
export { createRedis } from './redis.js';
export { createSesClient } from './ses-client.js';
export { createKafkaClient, createConsumer, createProducer } from './kafka.js';
export { runConsumer, type RunConsumerOptions } from './consumer.js';
```

Update `apps/dispatch-worker/package.json`:
```json
"main": "./dist/lib.js",
"types": "./dist/lib.d.ts",
```

Update the e2e test's import to `from '@ruguin/dispatch-worker'` (unchanged) — it now resolves to `lib.js`. Rebuild: `pnpm --filter @ruguin/dispatch-worker build`.

- [ ] **Step 3: Run the end-to-end test**

Run: `pnpm --filter @ruguin/api-service test`
Expected: PASS — the full suite (health, auth, templates, kafka, emails, e2e) is green, and the e2e test specifically proves an HTTP request reaches Postgres, Kafka, the Dispatch Worker, and a real (LocalStack) SES call, round-tripping back through Kafka.

- [ ] **Step 4: Run the full monorepo test suite as a final check**

Run: `pnpm test` (from the repo root — runs `turbo run test`, which builds `@ruguin/event-schemas` and `@ruguin/dispatch-worker` first per `turbo.json`'s `dependsOn: ["^build"]`, then tests every package)
Expected: all packages report PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api-service apps/dispatch-worker
git commit -m "test: add end-to-end smoke test covering API Service -> Kafka -> Dispatch Worker -> SES"
```

---

## Verification

After Task 11, the foundation is provably working:

1. `docker compose up -d` brings up Postgres, Redis, Kafka, and LocalStack (Task 2).
2. `pnpm --filter @ruguin/api-service run db:migrate` applies the schema (Task 5).
3. `pnpm --filter @ruguin/api-service dev` and `pnpm --filter @ruguin/dispatch-worker dev` run the two services locally.
4. A manual `curl -X POST http://localhost:3000/emails -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"from":"a@example.com","to":"b@example.com","subject":"Hi","html":"<p>Hi</p>"}'` (after seeding an org/project/api key by hand or via a short script) returns `202` and, within a second or two, the Dispatch Worker's logs show it called SES and published a `sent` status event.
5. `pnpm test` at the repo root is green end to end — this is the automated version of the same proof, and is what CI (when added) will run.

**Deferred to the next plan** (SES Webhook Ingestor, Tracking Service, Webhook Notifier, Read-Model Updater, dashboard): these consume the same `email.status.updated`/`email.engagement` topics already defined in `@ruguin/event-schemas` and don't require changes to this plan's services — they're additive.
