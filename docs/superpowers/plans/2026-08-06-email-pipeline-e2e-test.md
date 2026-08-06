# EMAIL-6 — Teste ponta a ponta do pipeline de envio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um teste automatizado (`apps/core-server/src/__tests__/email-pipeline.e2e.ts`) que sobe
`@ruguin/core-server` e `@ruguin/dispatch-worker` como dois processos Node reais e independentes,
chama `POST /v1/emails` de verdade, e observa `email.status.updated` (`status: 'sent'`,
`sesMessageId` presente) via um consumer Kafka dedicado — provando o pipeline de envio completo
funcionando com infraestrutura real (Postgres, Kafka, LocalStack SES), sem mocks nem simulação
interna.

**Architecture:** Dois processos spawnados via `node:child_process`, comunicando-se só por HTTP e
Kafka — exatamente como em produção. O teste roda como projeto Vitest próprio (`pipeline-e2e`),
fora do grafo padrão `test:e2e`/`test:all`, porque usa o mesmo `groupId` fixo (`'dispatch-worker'`)
que o e2e do próprio dispatch-worker e não pode rodar em paralelo com ele no CI.

**Tech Stack:** Vitest 4, `node:child_process` (nativo), `@ruguin/message-broker`
(`MessageBrokerModule` direto, sem `AppModule`), `@aws-sdk/client-ses` (v1 clássico — mesmo cliente
que `SesEmailSender` do dispatch-worker realmente usa), Prisma seed já existente.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-email-pipeline-e2e-test-design.md` (todas as decisões
  1-7 valem como requisito implícito de cada task abaixo).
- Ticket: `docs/tasks/EMAIL-6-teste-e2e-pipeline-envio.md` — só o caminho de sucesso; falhas já são
  cobertas pelo EMAIL-5.
- `test:pipeline-e2e` **não** entra em `turbo.json`'s `test:all`/`test:e2e` — roda como comando
  manual/CI explícito, separado dos `test:e2e` de cada app.
- Nenhuma mudança de comportamento em código de produção de `core-server` ou `dispatch-worker` —
  só teste, plumbing de teste, e um campo novo (não sensível) no output do seed.
- Toda função que devolve `Either` tem o tipo de retorno anotado (não se aplica a este plano — não
  há `Either` novo aqui).
- `pnpm --filter @ruguin/core-server test -- <pattern>` não filtra o run de forma confiável neste
  monorepo — use `npx vitest run --project <nome> <pattern>` de dentro de `apps/core-server/`.

---

## Task 1: Extrair o seed+parse do e2e para uma função reutilizável, com o e-mail do sender identity

**Files:**

- Create: `apps/core-server/prisma/run-seed.ts`
- Modify: `apps/core-server/prisma/seed.ts:70-76` (adiciona uma linha de output)
- Modify: `apps/core-server/vitest.setup.e2e.ts` (substitui o corpo por uma chamada à função extraída)
- Modify: `packages/env/src/packages/test-seed.environment.ts` (novo campo)

**Interfaces:**

- Produces: `runSeedAndCaptureIds(): void`, exportada de `apps/core-server/prisma/run-seed.ts`. Ao
  rodar, seta em `process.env`: `DATABASE_URL`, `ENVIRONMENT`, `KAFKA_BOOTSTRAP_BROKERS`,
  `CACHE_PREFIX`, `DOCS_USERNAME`, `DOCS_PASSWORD`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY` (todos por `??=`, idêntico ao que `vitest.setup.e2e.ts` já fazia), e
  `TEST_SEEDED_ORGANIZATION_ID`, `TEST_SEEDED_PROJECT_ID`, `TEST_SEEDED_SENDER_IDENTITY_ID`,
  `TEST_SEEDED_SENDER_IDENTITY_EMAIL` (novo), `TEST_SEEDED_TEMPLATE_ID`, `TEST_SEEDED_API_KEY`.
  Lança `Error` se qualquer um dos cinco campos parseados do seed vier `undefined`.
- Consumes (Task 2): `testSeedENV.TEST_SEEDED_SENDER_IDENTITY_EMAIL` (novo campo de
  `packages/env`'s `testSeedENV`) — usada pelo teste do Task 2 para verificar o remetente na SES
  antes do envio.

- [ ] **Step 1: Adicionar o e-mail do sender identity ao output do seed**

Em `apps/core-server/prisma/seed.ts`, logo depois da linha `console.log(\`  senderIdentityId:
${senderIdentity.id}\`)` (linha 73), adicione:

```ts
  console.log(`  senderIdentityEmail: ${senderIdentity.email}`)
```

O bloco de `console.log` (linhas 70-76 hoje) fica:

```ts
  console.log('Seeded development data:')
  console.log(`  organizationId:      ${organization.id}`)
  console.log(`  projectId:           ${project.id}`)
  console.log(`  senderIdentityId:    ${senderIdentity.id}`)
  console.log(`  senderIdentityEmail: ${senderIdentity.email}`)
  console.log(`  templateId:          ${template.id}`)
  console.log(`  API key:             ${rawApiKey}`)
  console.log('This key is shown once. It is not recoverable — re-run the seed to mint a new one.')
```

(realinhado os dois-pontos das linhas existentes para acompanhar o rótulo mais longo
`senderIdentityEmail:` — puramente cosmético, os regexes do Step 2 usam `\s+` depois do rótulo,
então a largura do alinhamento não afeta o parsing.)

- [ ] **Step 2: Criar `apps/core-server/prisma/run-seed.ts`**

Conteúdo completo — é o corpo de `vitest.setup.e2e.ts` de hoje, extraído para uma função exportada,
mais o novo campo `senderIdentityEmail`:

```ts
import { execSync } from 'node:child_process'

/*
 * Shared by both e2e globalSetups (the existing `e2e` project and the new `pipeline-e2e` project,
 * apps/core-server/vitest.config.ts) — each needs the exact same seeded organization/project/
 * sender identity/template/API key, and duplicating this parsing in two files would drift the
 * moment one of them changes the seed script's output format.
 */
export function runSeedAndCaptureIds(): void {
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=core_server'
  process.env.ENVIRONMENT ??= 'test'
  /*
   * app.module.ts now wires MessageBrokerModule (publishing side of the outbox→dispatch-worker
   * flow) — matches apps/dispatch-worker's own docker-compose Kafka listener.
   */
  process.env.KAFKA_BOOTSTRAP_BROKERS ??= 'localhost:9092'
  /*
   * CACHE_PREFIX has no default in cacheENV's schema (packages/env) — CACHE_DRIVER is left unset
   * so it falls back to 'memory', keeping the e2e suite self-sufficient without a live Valkey.
   */
  process.env.CACHE_PREFIX ??= 'ruguin-core-server-e2e'
  /*
   * docsENV requires both with no default (packages/env/src/packages/docs.environment.ts). Test-only
   * Basic Auth credentials for the /docs routes this suite never authenticates against — not a
   * secret, just what coreServerENV needs present to resolve at all.
   */
  process.env.DOCS_USERNAME ??= 'e2e-test'
  process.env.DOCS_PASSWORD ??= 'e2e-test'
  /*
   * awsENV's own fields all default or are optional except these — the SES v2 client (sender
   * identity registration) needs them to point at LocalStack instead of real AWS during e2e.
   * 'test'/'test' is the same placeholder value packages/env's own aws.environment.unit.ts already
   * uses for the identical purpose.
   */
  process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566'
  process.env.AWS_ACCESS_KEY_ID ??= 'test'
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test'

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- static command, no interpolated input; `pnpm exec` is the intended way to resolve workspace-local binaries via PATH.
  const seedOutput = execSync('pnpm exec tsx prisma/seed.ts', {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    encoding: 'utf8'
  })

  const organizationId = /organizationId:\s+(\S+)/.exec(seedOutput)?.[1]
  const projectId = /projectId:\s+(\S+)/.exec(seedOutput)?.[1]
  const senderIdentityId = /senderIdentityId:\s+(\S+)/.exec(seedOutput)?.[1]
  const senderIdentityEmail = /senderIdentityEmail:\s+(\S+)/.exec(seedOutput)?.[1]
  const templateId = /templateId:\s+(\S+)/.exec(seedOutput)?.[1]
  const apiKey = /API key:\s+(\S+)/.exec(seedOutput)?.[1]

  /*
   * Report which fields failed to parse, never the raw output — it carries the seeded API key in
   * cleartext, and this message can land in a CI log with far wider, longer-lived reach than the
   * terminal it was meant for.
   */
  if (
    organizationId === undefined ||
    projectId === undefined ||
    senderIdentityId === undefined ||
    senderIdentityEmail === undefined ||
    templateId === undefined ||
    apiKey === undefined
  ) {
    const missing = Object.entries({
      organizationId,
      projectId,
      senderIdentityId,
      senderIdentityEmail,
      templateId,
      apiKey
    })
      .filter(([, value]) => value === undefined)
      .map(([name]) => name)
    throw new Error(`Failed to parse seed output — missing: ${missing.join(', ')}.`)
  }

  process.env.TEST_SEEDED_ORGANIZATION_ID = organizationId
  process.env.TEST_SEEDED_PROJECT_ID = projectId
  process.env.TEST_SEEDED_SENDER_IDENTITY_ID = senderIdentityId
  process.env.TEST_SEEDED_SENDER_IDENTITY_EMAIL = senderIdentityEmail
  process.env.TEST_SEEDED_TEMPLATE_ID = templateId
  process.env.TEST_SEEDED_API_KEY = apiKey
}
```

Note o `cwd`: `new URL('..', import.meta.url).pathname` — `run-seed.ts` vive em `prisma/`, um nível
abaixo de onde `vitest.setup.e2e.ts` vivia (raiz do app); `..` sobe de `prisma/` para a raiz do
app, reproduzindo o mesmo `cwd` (`apps/core-server/`) que o `execSync` original usava.

- [ ] **Step 3: Reduzir `vitest.setup.e2e.ts` para uma chamada à função extraída**

Substitua o conteúdo inteiro de `apps/core-server/vitest.setup.e2e.ts` por:

```ts
import { runSeedAndCaptureIds } from './prisma/run-seed.ts'

/*
 * A globalSetup file (not setupFiles — see vitest.config.ts's e2e project) must export `setup`,
 * `teardown`, or a default function; Vitest throws otherwise. runSeedAndCaptureIds() runs exactly
 * once for the entire `vitest run --project e2e` invocation; the env vars it writes to
 * process.env are still visible to every test file because Vitest's worker pool spawns after
 * global setup finishes and inherits process.env at that point.
 */
export function setup(): void {
  runSeedAndCaptureIds()
}
```

- [ ] **Step 4: Adicionar `TEST_SEEDED_SENDER_IDENTITY_EMAIL` ao schema de `testSeedENV`**

Em `packages/env/src/packages/test-seed.environment.ts`, o `server: {}` ganha um campo novo. O
arquivo inteiro fica:

```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

/*
 * Consumed only by core-server's e2e suites: `vitest.setup.e2e.ts` seeds these ids into
 * `process.env` once per e2e test file, before the file's own module code runs. `lazyEnvironment`
 * defers validation to first property access, so importing `@ruguin/env` anywhere else — including
 * production boot — never touches these vars or fails because they're unset.
 */
export const testSeedENV = lazyEnvironment(() =>
  createEnv({
    server: {
      TEST_SEEDED_ORGANIZATION_ID: z.string().min(1),
      TEST_SEEDED_PROJECT_ID: z.string().min(1),
      TEST_SEEDED_SENDER_IDENTITY_ID: z.string().min(1),
      TEST_SEEDED_SENDER_IDENTITY_EMAIL: z.string().min(1),
      TEST_SEEDED_TEMPLATE_ID: z.string().min(1),
      TEST_SEEDED_API_KEY: z.string().min(1)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

- [ ] **Step 5: Rodar o `check:types` e o `check:lint` de `@ruguin/core-server` e de `@ruguin/env`**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Run: `pnpm --filter @ruguin/env check:types`
Expected: sem erros nos dois comandos.

- [ ] **Step 6: Rodar a suíte e2e existente do core-server para confirmar que o refactor não quebrou nada**

Precondição: `pnpm infra:up` já rodando (Postgres de pé).

Run: `pnpm --filter @ruguin/core-server test:e2e`
Expected: PASS — todos os testes que já existiam antes deste task continuam verdes (a suíte usa o
`senderIdentityId`/`templateId`/`apiKey` já parseados por `runSeedAndCaptureIds()`, agora chamada
por dentro do `globalSetup` reduzido do Step 3).

- [ ] **Step 7: Commit**

```bash
git add apps/core-server/prisma/run-seed.ts apps/core-server/prisma/seed.ts apps/core-server/vitest.setup.e2e.ts packages/env/src/packages/test-seed.environment.ts
git commit -m "refactor(core-server): extract e2e seed+parse into a reusable function, add sender identity email"
```

---

## Task 2: O teste ponta a ponta — dois processos reais, HTTP real, Kafka real

**Files:**

- Create: `apps/core-server/src/__tests__/email-pipeline.e2e.ts`
- Modify: `apps/core-server/vitest.config.ts` (exclui o arquivo novo do projeto `e2e`, adiciona o
  projeto `pipeline-e2e`)
- Modify: `apps/core-server/package.json` (script `test:pipeline-e2e`, devDependency
  `@aws-sdk/client-ses`)

**Interfaces:**

- Consumes (Task 1): `runSeedAndCaptureIds()` de `../../prisma/run-seed.ts`;
  `testSeedENV.TEST_SEEDED_SENDER_IDENTITY_EMAIL`, `TEST_SEEDED_TEMPLATE_ID`, `TEST_SEEDED_API_KEY`
  (de `@ruguin/env`).
- Consumes (código já existente): `createMessageBrokerModuleOptions()` de
  `../shared/infrastructure/message-broker/message-broker-module-options.ts`; `awsENV` de
  `@ruguin/env`; `EMAIL_STATUS_UPDATED_TOPIC` de `@ruguin/event-schemas`; `MessageBrokerModule`,
  `MESSAGE_CONSUMER_PORT`, `type MessageConsumerPort` de `@ruguin/message-broker`.

- [ ] **Step 1: Adicionar `@aws-sdk/client-ses` como devDependency do core-server**

Em `apps/core-server/package.json`, dentro de `"devDependencies"`, adicione (ordem alfabética,
entre `"@ruguin/typescript-config"` e `"@swc/cli"`):

```json
    "@aws-sdk/client-ses": "^3.700.0",
```

Mesma versão que `apps/dispatch-worker/package.json` já fixa — é o mesmo cliente SES clássico
(v1) que `SesEmailSender` do dispatch-worker realmente usa para enviar (`Source:`/`SendEmailCommand`),
diferente do `@aws-sdk/client-sesv2` que core-server já tem para o CRUD de `SenderIdentity`. Este
teste precisa do v1 porque é contra ele que precisa verificar o remetente na LocalStack antes do
envio real (mesmo motivo por que `dispatch-email.e2e.ts` do dispatch-worker usa v1, não v2).

Run: `pnpm install` (na raiz do monorepo)
Expected: `pnpm-lock.yaml` atualizado, `node_modules/@aws-sdk/client-ses` presente em
`apps/core-server`.

- [ ] **Step 2: Ajustar `apps/core-server/vitest.config.ts` — excluir o arquivo novo do projeto `e2e`, criar `pipeline-e2e`**

No bloco `projects`, o projeto `e2e` (linhas 103-120 hoje) ganha `exclude`, e um projeto novo é
adicionado logo depois dele. O array `projects` inteiro fica:

```ts
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/__tests__/**/*.unit.ts'],
          testTimeout: 5000
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/__tests__/**/*.int.ts'],
          testTimeout: 15_000,
          /*
           * The outbox .int.ts suites share one Postgres database/schema and one outbox_messages
           * table — OutboxRelayService publishes rows that other suites' partition/retention
           * assertions depend on, so files in this project must not run concurrently.
           */
          fileParallelism: false
        }
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['src/**/__tests__/**/*.e2e.ts'],
          /*
           * email-pipeline.e2e.ts lives in its own 'pipeline-e2e' project (below), not here: it
           * spawns real core-server + dispatch-worker processes sharing the dispatch-worker
           * consumer's fixed groupId ('dispatch-worker') — running it inside this project would let
           * Turbo schedule it in parallel with dispatch-worker's own test:e2e in CI, and the two
           * would steal Kafka messages from each other on that groupId.
           */
          exclude: ['src/__tests__/email-pipeline.e2e.ts'],
          /*
           * globalSetup, not setupFiles: setupFiles re-runs once per test FILE, and this file's
           * job is to run prisma/seed.ts once and hand every test file the same seeded
           * organization/project/sender identity via process.env — running it once per file would
           * mint a different set of IDs per file with no way to share them. globalSetup runs
           * exactly once for the entire `vitest run --project e2e` invocation; the env vars it
           * writes to process.env are still visible to every test file because Vitest's worker
           * pool spawns after global setup finishes and inherits process.env at that point.
           */
          globalSetup: ['./vitest.setup.e2e.ts'],
          testTimeout: 30_000
        }
      },
      {
        extends: true,
        test: {
          name: 'pipeline-e2e',
          include: ['src/__tests__/email-pipeline.e2e.ts'],
          /*
           * Same globalSetup mechanism as the 'e2e' project above (see its comment) — this project
           * needs the identical seeded organization/project/sender identity/template/API key, plus
           * the same DATABASE_URL/KAFKA_BOOTSTRAP_BROKERS/AWS_* defaults, so the two real processes
           * spawned by the test inherit a working environment (see decision 3 of the design spec).
           */
          globalSetup: ['./vitest.setup.e2e.ts'],
          testTimeout: 90_000
        }
      }
    ]
```

- [ ] **Step 3: Adicionar o script `test:pipeline-e2e` ao `package.json`**

Em `apps/core-server/package.json`, dentro de `"scripts"`, logo depois de `"test:integration"`
(ordem alfabética seguiria `test:pipeline-e2e` antes de `test:watch` — mantenha a lista alfabética
como já está):

```json
    "test:pipeline-e2e": "pnpm run build && pnpm --filter @ruguin/dispatch-worker build && vitest run --project pipeline-e2e",
```

Builda os dois apps antes de rodar — `pnpm --filter <app> start` (usado pelo teste do Step 5) roda
a partir de `dist/`, não de `src/`. Fora do grafo do Turbo de propósito (ver Global Constraints).

- [ ] **Step 4: Escrever `apps/core-server/src/__tests__/email-pipeline.e2e.ts`**

Conteúdo completo:

```ts
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import { SESClient, VerifyEmailIdentityCommand } from '@aws-sdk/client-ses'
import { Test, type TestingModule } from '@nestjs/testing'
import { awsENV, testSeedENV } from '@ruguin/env'
import { EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_CONSUMER_PORT, MessageBrokerModule, type MessageConsumerPort } from '@ruguin/message-broker'
import { success } from '@ruguin/utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createMessageBrokerModuleOptions } from '../shared/infrastructure/message-broker/message-broker-module-options'

const CORE_SERVER_PORT = 3333
const DISPATCH_WORKER_PORT = 3334
const HEALTH_POLL_INTERVAL_MS = 500
const HEALTH_POLL_TIMEOUT_MS = 30_000
const BOOT_TIMEOUT_MS = HEALTH_POLL_TIMEOUT_MS + 15_000
const STATUS_EVENT_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 60_000

type SpawnedApp = Readonly<{
  packageName: string
  process: ChildProcessWithoutNullStreams
  output: string[]
}>

/*
 * pnpm --filter resolves the target package from anywhere inside the workspace, so this doesn't
 * need repo-root cwd math — process.cwd() during `vitest run --project pipeline-e2e` is already
 * apps/core-server/, itself inside the workspace. shell: true because pnpm's own binary may be a
 * shell-wrapped shim depending on how it was installed — the two args passed are both hardcoded
 * package names below, never interpolated user input.
 */
// eslint-disable-next-line sonarjs/no-os-command-from-path -- static command, no interpolated input; `pnpm --filter` is the intended way to run a workspace package's own script.
function spawnApp(packageName: string): SpawnedApp {
  const output: string[] = []
  const child = spawn('pnpm', ['--filter', packageName, 'start'], {
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    stdio: 'pipe'
  })
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  return { packageName, process: child, output }
}

async function waitForHealthy(app: SpawnedApp, port: number): Promise<void> {
  try {
    await vi.waitUntil(
      async () => {
        try {
          const response = await fetch(`http://localhost:${port}/health`)
          return response.status === 200
        } catch {
          return false
        }
      },
      { timeout: HEALTH_POLL_TIMEOUT_MS, interval: HEALTH_POLL_INTERVAL_MS }
    )
  } catch (error) {
    // The buffered stdout/stderr is the only diagnostic for why boot never reached a healthy state.
    throw new Error(`${app.packageName} never became healthy on port ${port}:\n${app.output.join('')}`, {
      cause: error
    })
  }
}

function killApp(app: SpawnedApp): Promise<void> {
  return new Promise((resolve) => {
    const forceKillTimer = setTimeout(() => {
      app.process.kill('SIGKILL')
    }, 5000)
    app.process.once('exit', () => {
      clearTimeout(forceKillTimer)
      resolve()
    })
    app.process.kill('SIGTERM')
  })
}

describe('Email send pipeline end to end (core-server + dispatch-worker as real processes)', () => {
  let coreServer: SpawnedApp
  let dispatchWorker: SpawnedApp
  let moduleReference: TestingModule
  let consumer: MessageConsumerPort

  beforeAll(async () => {
    /*
     * prisma/seed.ts writes SenderIdentity.verifiedAt directly, without ever calling the real SES
     * CreateEmailIdentity (design spec decision 9 of the SenderIdentity plan) — LocalStack has no
     * record of this identity, and SesEmailSender (apps/dispatch-worker/.../ses-email-sender.ts)
     * uses it as the SendEmailCommand's Source. Verify it here first, the same way
     * dispatch-email.e2e.ts (dispatch-worker) pre-verifies its own hardcoded address.
     */
    const sesClient = new SESClient({
      region: awsENV.AWS_REGION,
      ...(awsENV.AWS_ENDPOINT_URL !== undefined && { endpoint: awsENV.AWS_ENDPOINT_URL }),
      ...(awsENV.AWS_ACCESS_KEY_ID !== undefined &&
        awsENV.AWS_SECRET_ACCESS_KEY !== undefined && {
          credentials: { accessKeyId: awsENV.AWS_ACCESS_KEY_ID, secretAccessKey: awsENV.AWS_SECRET_ACCESS_KEY }
        })
    })
    await sesClient.send(
      new VerifyEmailIdentityCommand({ EmailAddress: testSeedENV.TEST_SEEDED_SENDER_IDENTITY_EMAIL })
    )

    coreServer = spawnApp('@ruguin/core-server')
    dispatchWorker = spawnApp('@ruguin/dispatch-worker')
    await Promise.all([
      waitForHealthy(coreServer, CORE_SERVER_PORT),
      waitForHealthy(dispatchWorker, DISPATCH_WORKER_PORT)
    ])

    /*
     * A standalone MessageBrokerModule host, not either app's AppModule — this test only needs a
     * Kafka consumer to observe email.status.updated from the outside, exactly like a third-party
     * client would. createMessageBrokerModuleOptions() is core-server's own options builder,
     * reused so brokers/clientId/ssl match what the real core-server process above uses.
     */
    moduleReference = await Test.createTestingModule({
      imports: [MessageBrokerModule.forRoot(createMessageBrokerModuleOptions())]
    }).compile()
    await moduleReference.init()
    consumer = moduleReference.get<MessageConsumerPort>(MESSAGE_CONSUMER_PORT)
  }, BOOT_TIMEOUT_MS)

  afterAll(async () => {
    await moduleReference?.close()
    await Promise.all([killApp(coreServer), killApp(dispatchWorker)])
  })

  it(
    'sends an email through POST /v1/emails and observes email.status.updated with status=sent',
    async () => {
      const statusEvents: unknown[] = []
      await consumer.subscribe({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        groupId: `pipeline-e2e-${Date.now()}`,
        onMessage: (message) => {
          statusEvents.push(message.payload)
          return Promise.resolve(success(undefined))
        }
      })

      const response = await fetch(`http://localhost:${CORE_SERVER_PORT}/v1/emails`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${testSeedENV.TEST_SEEDED_API_KEY}`
        },
        body: JSON.stringify({
          to: 'pipeline-e2e-recipient@example.com',
          templateId: testSeedENV.TEST_SEEDED_TEMPLATE_ID,
          variables: { name: 'Pipeline E2E' }
        })
      })

      expect(response.status).toBe(202)
      const body = (await response.json()) as { id: string; status: string }
      expect(body.status).toBe('queued')
      expect(body.id.length).toBeGreaterThan(0)

      await vi.waitUntil(
        () => statusEvents.some((event) => (event as { emailId: string }).emailId === body.id),
        { timeout: STATUS_EVENT_TIMEOUT_MS, interval: 200 }
      )

      expect(statusEvents).toContainEqual(
        expect.objectContaining({ emailId: body.id, status: 'sent', sesMessageId: expect.any(String) })
      )
    },
    TEST_TIMEOUT_MS
  )
})
```

- [ ] **Step 5: Rodar o teste**

Precondição: `pnpm infra:up` já rodando (Postgres, Kafka, LocalStack de pé).

Run (de dentro de `apps/core-server/`): `pnpm run test:pipeline-e2e`
Expected: PASS — 1 arquivo, 1 teste. O output do processo do core-server e do dispatch-worker
aparece só se `waitForHealthy` estourar o timeout (diagnóstico); em caso de sucesso a saída é só o
relatório normal do Vitest.

Se o teste travar sem nunca sair do `beforeAll`: confirme que as portas 3333/3334 não estão
ocupadas por outro processo (`lsof -i :3333`, `lsof -i :3334`) — um `pnpm dev`/`pnpm start` já
rodando localmente colidiria com os processos que este teste sobe.

- [ ] **Step 6: Rodar `check:types` e `check:lint` de novo, agora com o arquivo do Step 4 presente**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: sem erros.

- [ ] **Step 7: Confirmar que o projeto `e2e` continua excluindo o arquivo novo**

Run: `pnpm --filter @ruguin/core-server test:e2e`
Expected: PASS, e a lista de arquivos rodados (Vitest imprime "Test Files") **não inclui**
`email-pipeline.e2e.ts` — só os arquivos que já existiam antes deste plano.

- [ ] **Step 8: Commit**

```bash
git add apps/core-server/src/__tests__/email-pipeline.e2e.ts apps/core-server/vitest.config.ts apps/core-server/package.json pnpm-lock.yaml
git commit -m "test(core-server): add real-process e2e test for the full email send pipeline"
```

---

## Self-Review

**Cobertura da spec:** decisão 1 (dois processos reais) → Task 2 Step 4 (`spawnApp`/`child_process`,
zero import de `AppModule`). Decisão 2 (localização/exclusão do projeto `e2e`) → Task 2 Steps 2-3.
Decisão 3 (orquestração: seed, verificação SES, spawn, health poll) → Task 2 Step 4 (`beforeAll`).
Decisão 4 (observar via `MessageBrokerModule` direto) → Task 2 Step 4 (`moduleReference`/`consumer`).
Decisão 5 (reuso do seed) → Task 1 inteira. Decisão 6 (corpo da requisição/asserts) → Task 2 Step 4
(`it(...)`). Decisão 7 (timeouts) → constantes no topo do arquivo do Step 4, e `testTimeout: 90_000`
do projeto `pipeline-e2e` (Task 2 Step 2).

**Placeholders:** nenhum "TBD"/"implement later" — todo bloco de código é conteúdo final, copiável.

**Consistência de tipos:** `SpawnedApp` definido uma vez (Task 2 Step 4) e usado do mesmo jeito em
`spawnApp`/`waitForHealthy`/`killApp`. `runSeedAndCaptureIds(): void` (Task 1 Step 2) é a única
função exportada de `run-seed.ts`, consumida sem parâmetros tanto pelo `globalSetup` do projeto
`e2e` (Task 1 Step 3) quanto pelo do projeto `pipeline-e2e` (Task 2 Step 2) — mesma assinatura nos
dois lugares. `TEST_SEEDED_SENDER_IDENTITY_EMAIL` tem o mesmo nome em `seed.ts` (rótulo de log),
`run-seed.ts` (regex + `process.env`) e `test-seed.environment.ts` (schema) — os três precisam
bater literalmente ou o parsing silenciosamente falha com "missing: senderIdentityEmail" no Step 6
da Task 1.
