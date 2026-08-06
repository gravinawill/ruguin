# Templates via React Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `Template.subject`/`Template.html` from hand-written seed strings into build-time output of a React Email component, add a first-class `text` (plain-text) field alongside `subject`/`html` through the whole send pipeline, and cache the `Template` lookup in the send hot path.

**Architecture:** A new workspace package (`packages/email-templates`) holds React Email `.tsx` components and a build-time render function producing `{ subject, html, text }` with `{{variable}}` placeholders still literal. `apps/core-server`'s `prisma/seed.ts` consumes that output; the rest of the send pipeline (`renderTemplate`, `Email`, the Kafka payload, `apps/dispatch-worker`'s `SesEmailSender`) is extended to carry `text` the same way it already carries `subject`/`html`. A new `TemplateCacheProvider` (cache-aside over `@ruguin/cache`) removes the uncached Postgres read that today happens on every single email send.

**Tech Stack:** React 19, `@react-email/components`, `@react-email/render`, `react-email` (CLI), `tsdown` (package build), Prisma 7, NestJS, Zod, `@ruguin/cache`.

## Global Constraints

- **`packages/email-templates` must be built before any consumer resolves it.** Same rule as
  every other workspace package (`packages/env`'s `CLAUDE.md`): `pnpm --filter @ruguin/email-templates
  build` before running `check:types`/tests in `apps/core-server` after touching this package —
  otherwise a stale `dist/` silently masks real changes (this exact class of bug produced a Critical
  finding earlier in this project).
- **Cache namespace strings must never contain `:` or whitespace** (`KeyBuilder.validateSegment`,
  `packages/cache/src/infra/key-builder.ts`) — `'core-server-template'` (hyphen) is correct,
  `'core-server:template'` is not.
- **Any function returning `Either` must have its return type explicitly annotated.**
  `success(x)` alone infers `Either<unknown, X>` — the error type only appears via the annotation.
- **`TemplateCacheProvider.get()` must rehydrate the cached `Template` via `Template.create(...)`
  unconditionally — hit or miss, not just on miss.** `IGetOrSetCacheProvider.getOrSet`'s cache-HIT
  path round-trips the value through JSON serialization on **every** driver, including `'memory'` —
  it strips the class prototype, turning a `Template` instance into a plain object that looks the
  same but has no methods. This exact bug was found and fixed in `SenderIdentityCacheProvider` in
  the prior plan (`docs/superpowers/plans/2026-08-05-sender-identity.md`, Task 13) — Task 5 below
  bakes the fix in from the start; no separate fix round should be needed.
- **`Template.text`/`Email.text` are added `NOT NULL`, no default** (project is pre-production, no
  backfill required — same posture already established for `Template.senderIdentityId`/
  `Email.senderIdentityId`). Before applying either migration, reset the local Postgres
  (`docker compose -f infrastructure/local/docker-compose.yml down -v postgres && docker compose -f
  infrastructure/local/docker-compose.yml up -d postgres`), then reapply every prior migration
  (`pnpm with-env pnpm --filter @ruguin/core-server db:deploy`) before the new one.
- **`Email.text` going `NOT NULL` (Task 3) is EXPECTED to break `send-email.use-case.ts`, its unit
  test, and `email.controller.unit.ts`'s fixtures.** This is deferred to Task 7 on purpose — same
  pattern the prior plan used for `Email.senderIdentityId`/`templateId` (Task 10 broke it, Task 11
  fixed it). Do not attempt to fix this early; only confirm in Task 3 that the breakage is exactly
  this and nothing else.
- **`packages/event-schemas` has no build/dist step** — consumed straight from `src/`, confirmed in
  the prior plan's Task 12 review. No stale-dist risk there specifically.
- **Follow `SenderIdentityCacheProvider`/`SenderIdentityRepository`'s existing pattern exactly** for
  `TemplateCacheProvider` (contract in `domain/contracts/`, adapter in `infrastructure/cache/`,
  `Symbol` token, constructor `@Inject`s). Read
  `apps/core-server/src/modules/sender-identities/infrastructure/cache/sender-identity-cache.provider.ts`
  if you need the reference implementation — Task 5 below already reproduces it in full.

---

### Task 1: `packages/email-templates` — Welcome component + render function

**Files:**

- Create: `packages/email-templates/package.json`
- Create: `packages/email-templates/tsconfig.json`
- Create: `packages/email-templates/tsdown.config.ts`
- Create: `packages/email-templates/eslint.config.ts`
- Create: `packages/email-templates/vitest.config.ts`
- Create: `packages/email-templates/src/templates/welcome.tsx`
- Create: `packages/email-templates/src/render.tsx`
- Create: `packages/email-templates/src/index.ts`
- Test: `packages/email-templates/src/__tests__/render.unit.ts`

**Interfaces:**

- Produces: `renderWelcomeEmailTemplate(): Promise<{ subject: string; html: string; text: string }>`,
  exported from `@ruguin/email-templates`. Consumed by Task 2's `prisma/seed.ts`.

- [ ] **Step 1: Scaffold the package manifest**

Create `packages/email-templates/package.json`:

```json
{
  "name": "@ruguin/email-templates",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs"
    }
  },
  "main": "./dist/index.mjs",
  "types": "./dist/index.d.mts",
  "scripts": {
    "build": "tsdown",
    "check:lint": "eslint . --max-warnings 0",
    "check:types": "tsc --noEmit --pretty",
    "clean": "rm -rf .claude-flow .swarm .superpowers .remember .gitnexus .turbo coverage node_modules dist build",
    "dev": "email dev --dir src/templates",
    "fix:lint": "eslint --fix .",
    "test:all": "vitest run",
    "test:cov": "vitest run --coverage",
    "test:unit": "vitest run",
    "update:deps": "ncu -u"
  },
  "lint-staged": {
    "*.{ts,tsx}": "eslint --fix"
  },
  "devDependencies": {
    "@ruguin/eslint-config": "workspace:*",
    "@ruguin/typescript-config": "workspace:*",
    "@types/node": "^26.1.2",
    "npm-check-updates": "23.0.0",
    "tsdown": "^0.22.14",
    "typescript": "6.0.3",
    "vitest": "^4.1.10",
    "vitest-sonar-reporter": "^3.0.0"
  }
}
```

This mirrors `packages/utils/package.json` exactly for every field whose version is already pinned
elsewhere in this workspace. The React Email stack itself is deliberately **not** hand-typed here —
Step 2 installs it via `pnpm add` so the actually-published current versions get resolved, instead
of guessing numbers that could already be stale by the time this plan is implemented.

- [ ] **Step 2: Install the React Email stack**

Run, from the repo root:

```bash
pnpm --filter @ruguin/email-templates add react react-dom
pnpm --filter @ruguin/email-templates add @react-email/components @react-email/render
pnpm --filter @ruguin/email-templates add -D react-email @types/react @types/react-dom
```

Expected: `package.json`'s `dependencies` gains `react`, `react-dom`, `@react-email/components`,
`@react-email/render`; `devDependencies` gains `react-email`, `@types/react`, `@types/react-dom`.
If `pnpm` reports a blocked build script for any of these packages, add its name to the root
`pnpm-workspace.yaml`'s `onlyBuiltDependencies` array — check the existing entries there
(`@prisma/engines`, `@swc/core`, `esbuild`, `prisma`, `unrs-resolver`) for the pattern.

- [ ] **Step 3: Add `tsconfig.json`, extending the React preset**

Create `packages/email-templates/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ruguin/typescript-config/react-library.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vitest.config.ts", "eslint.config.ts", "tsdown.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

`@ruguin/typescript-config/react-library.json` already exists in this workspace (`"jsx":
"react-jsx"`, extends `base.json`) — it has no consumer yet, this is the first. Unlike every other
package in this monorepo (plain `.ts`, no JSX), `include` here needs the extra `src/**/*.tsx` glob.

- [ ] **Step 4: Add `tsdown.config.ts`, `eslint.config.ts`, `vitest.config.ts`**

Create `packages/email-templates/tsdown.config.ts`:

```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  dts: true,
  unbundle: false
})
```

Same shape as every other package's `tsdown.config.ts` (see `packages/utils/tsdown.config.ts`) —
`tsdown` resolves the `.tsx` files `src/index.ts` imports transitively; it does not need a separate
entry per file.

Create `packages/email-templates/eslint.config.ts`:

```ts
import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig({})
```

Create `packages/email-templates/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.ts'],
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose', 'vitest-sonar-reporter'],
    outputFile: { 'vitest-sonar-reporter': './coverage/sonar-report.xml' },
    testTimeout: 5000,
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/generated/**', 'src/**/__tests__/**', '**/*.config.ts', 'dist/**']
    }
  }
})
```

Same shape as `packages/utils/vitest.config.ts`, without the 100% coverage threshold block (React
Email components render markup — asserting on every branch of generated HTML is not a useful bar
for this package; skip the `thresholds` key entirely rather than set a lower number nobody chose on
purpose).

- [ ] **Step 5: Write the failing render test**

Create `packages/email-templates/src/__tests__/render.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { renderWelcomeEmailTemplate } from '../render'

describe('renderWelcomeEmailTemplate', () => {
  it('returns the subject with the {{name}} placeholder literal', async () => {
    const result = await renderWelcomeEmailTemplate()

    expect(result.subject).toBe('Hi {{name}}')
  })

  it('returns html containing the {{name}} placeholder literal, not a substituted value', async () => {
    const result = await renderWelcomeEmailTemplate()

    expect(result.html).toContain('{{name}}')
  })

  it('returns a plain-text version containing the {{name}} placeholder literal', async () => {
    const result = await renderWelcomeEmailTemplate()

    expect(result.text).toContain('{{name}}')
  })

  it('returns html wrapped in a full HTML document', async () => {
    const result = await renderWelcomeEmailTemplate()

    expect(result.html).toContain('<html')
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/email-templates test:unit`
Expected: FAIL — `../render` does not exist yet.

- [ ] **Step 7: Write the `WelcomeEmail` component**

Create `packages/email-templates/src/templates/welcome.tsx`:

```tsx
import { Body, Container, Head, Html, Preview, Text } from '@react-email/components'

export const subject = 'Hi {{name}}'

export function WelcomeEmail(props: { name: string }) {
  return (
    <Html>
      <Head />
      <Preview>Welcome to Ruguin</Preview>
      <Body style={{ fontFamily: 'sans-serif', backgroundColor: '#ffffff' }}>
        <Container>
          <Text>Hi {props.name}</Text>
        </Container>
      </Body>
    </Html>
  )
}
```

The component treats `name` as an ordinary string prop — it has no awareness of the `{{name}}`
placeholder convention. That convention lives entirely in `render.tsx` (Step 8), which is what
decides to call this component with the literal string `'{{name}}'` instead of a real name.

- [ ] **Step 8: Write the render function**

Create `packages/email-templates/src/render.tsx`:

```tsx
import { render } from '@react-email/render'

import { subject, WelcomeEmail } from './templates/welcome'

export async function renderWelcomeEmailTemplate(): Promise<{ subject: string; html: string; text: string }> {
  const element = <WelcomeEmail name="{{name}}" />
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])

  return { subject, html, text }
}
```

`render()` from `@react-email/render` is async — it returns `Promise<string>`. `name="{{name}}"`
passes the literal placeholder string as the prop value; the component (Step 7) renders it as
ordinary text, so both `render()` calls emit `{{name}}` verbatim in their output.

- [ ] **Step 9: Write the barrel export**

Create `packages/email-templates/src/index.ts`:

```ts
export { renderWelcomeEmailTemplate } from './render'
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/email-templates test:unit`
Expected: PASS (4 tests).

- [ ] **Step 11: Run type check and lint**

Run: `pnpm --filter @ruguin/email-templates check:types && pnpm --filter @ruguin/email-templates check:lint`
Expected: PASS. If `check:lint` flags something in the JSX (e.g. `Style` prop shape, unused import),
fix it in place — this is the first `.tsx` file in the workspace, so this is where any adjustment to
`@ruguin/eslint-config`'s handling of JSX gets discovered, not invented ahead of time.

- [ ] **Step 12: Build the package**

Run: `pnpm --filter @ruguin/email-templates build`
Expected: PASS, `dist/index.mjs` and `dist/index.d.mts` created. This is the empirical confirmation
that `tsdown` handles `.tsx`/JSX correctly in this workspace — the design spec flagged this as an
open risk; this step resolves it. If `tsdown` errors on the JSX syntax, check that
`tsconfig.json`'s `compilerOptions.jsx` is actually being picked up (it inherits from
`react-library.json` via `extends` — `tsdown` reads the local `tsconfig.json`, so confirm it
resolves the `extends` chain correctly, e.g. by running `tsc --showConfig` and checking `jsx` in
the output).

- [ ] **Step 13: Commit**

```bash
git add packages/email-templates pnpm-lock.yaml
git commit -m "feat(email-templates): add Welcome template component and render function"
```

---

### Task 2: `Template.text`

**Files:**

- Modify: `apps/core-server/prisma/schema/template.prisma`
- Create: `apps/core-server/prisma/migrations/20260806070000_add_template_text/migration.sql`
- Modify: `apps/core-server/src/modules/templates/domain/models/template.model.ts`
- Test: `apps/core-server/src/modules/templates/domain/models/__tests__/template.model.unit.ts` (modify)
- Modify: `apps/core-server/src/modules/templates/infrastructure/database/prisma/template.repository.ts`
- Test: `apps/core-server/src/modules/templates/infrastructure/database/prisma/__tests__/template.repository.unit.ts` (modify)
- Modify: `apps/core-server/prisma/seed.ts`

**Interfaces:**

- Consumes: `renderWelcomeEmailTemplate()` from `@ruguin/email-templates` (Task 1).
- Produces: `Template.create(input: {..., text: string, ...})` — the constructor parameter order
  becomes `(id, projectId, senderIdentityId, name, subject, html, text, createdAt)`, consumed by
  Task 5's `TemplateCacheProvider` and Task 7's `SendEmailUseCase`.

- [ ] **Step 1: Reset the local dev database**

Run: `docker compose -f infrastructure/local/docker-compose.yml down -v postgres && docker compose -f infrastructure/local/docker-compose.yml up -d postgres`
Then reapply every prior migration: `pnpm with-env pnpm --filter @ruguin/core-server db:deploy`

`ALTER TABLE ... ADD COLUMN ... NOT NULL` with no default fails against a non-empty table — this
project is pre-production, no backfill needed (same posture as every migration in the prior plan).

- [ ] **Step 2: Add the column to the Prisma schema**

Replace the full contents of `apps/core-server/prisma/schema/template.prisma`:

```prisma
model Template {
  id               String   @id @default(uuid(7))
  projectId        String
  senderIdentityId String
  name             String
  subject          String
  html             String
  text             String
  createdAt        DateTime @default(now())

  @@index([projectId])
  @@index([senderIdentityId])
  @@map("templates")
}
```

- [ ] **Step 3: Write the migration by hand**

Create the directory `apps/core-server/prisma/migrations/20260806070000_add_template_text/` and
inside it `migration.sql`:

```sql
-- AlterTable
ALTER TABLE "templates" ADD COLUMN "text" TEXT NOT NULL;
```

Apply it: `pnpm with-env pnpm --filter @ruguin/core-server db:deploy`
Then regenerate the client: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 4: Update the failing model test**

Replace the full contents of `apps/core-server/src/modules/templates/domain/models/__tests__/template.model.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Template } from '../template.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Template' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Template.create', () => {
  it('builds a Template from valid input', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      text: 'Hi {{name}}',
      createdAt: new Date('2026-08-06T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('rejects an empty senderIdentityId', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: '',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      text: 'Hi {{name}}',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty subject', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: '',
      html: '<p>Hi {{name}}</p>',
      text: 'Hi {{name}}',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty html', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '',
      text: 'Hi {{name}}',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty text', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      text: '',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- template.model.unit`
Expected: FAIL — `Template.create` doesn't require `text` yet.

- [ ] **Step 5: Update the model**

Replace the full contents of `apps/core-server/src/modules/templates/domain/models/template.model.ts`:

```ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidTemplateError } from '../errors/invalid-template.error'

export class Template {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly senderIdentityId: string,
    readonly name: string,
    readonly subject: string,
    readonly html: string,
    readonly text: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    senderIdentityId: string
    name: string
    subject: string
    html: string
    text: string
    createdAt: Date
  }): Either<InvalidTemplateError, Template> {
    if (input.senderIdentityId.trim().length === 0) {
      return failure(new InvalidTemplateError({ reason: 'senderIdentityId is empty' }))
    }
    if (input.subject.trim().length === 0) return failure(new InvalidTemplateError({ reason: 'subject is empty' }))
    if (input.html.trim().length === 0) return failure(new InvalidTemplateError({ reason: 'html is empty' }))
    if (input.text.trim().length === 0) return failure(new InvalidTemplateError({ reason: 'text is empty' }))

    return success(
      new Template(
        input.id,
        input.projectId,
        input.senderIdentityId,
        input.name,
        input.subject,
        input.html,
        input.text,
        input.createdAt
      )
    )
  }
}
```

- [ ] **Step 6: Run the model test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- template.model.unit`
Expected: PASS (5 tests).

- [ ] **Step 7: Update the repository and its test**

Replace the full contents of `apps/core-server/src/modules/templates/infrastructure/database/prisma/template.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'
import { type TemplateLookupProvider } from '../../../domain/contracts/template-lookup.provider'
import { FindTemplateError } from '../../../domain/errors/find-template.error'
import { InvalidTemplateError } from '../../../domain/errors/invalid-template.error'
import { Template } from '../../../domain/models/template.model'

@Injectable()
export class TemplateRepository implements TemplateLookupProvider {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    projectId: string
    senderIdentityId: string
    name: string
    subject: string
    html: string
    text: string
    createdAt: Date
  }): Either<InvalidTemplateError, Template> {
    const idResult = ID.validate({ id: row.id, modelName: 'Template' })
    if (idResult.isFailure()) return failure(new InvalidTemplateError({ reason: idResult.value.message }))

    return Template.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      senderIdentityId: row.senderIdentityId,
      name: row.name,
      subject: row.subject,
      html: row.html,
      text: row.text,
      createdAt: row.createdAt
    })
  }

  public async findByIdAndProjectId(input: {
    templateId: string
    projectId: string
  }): Promise<Either<FindTemplateError, { template: Template | null }>> {
    try {
      /*
       * Scoped by BOTH columns in the query itself — never fetched by id alone and filtered after,
       * which would make the isolation check a runtime `if` instead of a query-shape guarantee.
       */
      const row = await this.prisma.template.findFirst({ where: { id: input.templateId, projectId: input.projectId } })
      if (row === null) return success({ template: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindTemplateError({ error: mapped.value }))

      return success({ template: mapped.value })
    } catch (error: unknown) {
      return failure(new FindTemplateError({ error }))
    }
  }
}
```

Replace the full contents of `apps/core-server/src/modules/templates/infrastructure/database/prisma/__tests__/template.repository.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type PrismaService } from '../../../../../../shared/infrastructure/database/prisma/prisma.service'
import { TemplateRepository } from '../template.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Template' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('TemplateRepository#findByIdAndProjectId', () => {
  it('maps a found row scoped to the project', async () => {
    const id = validId()
    const findFirst = vi.fn().mockResolvedValue({
      id: id.toString(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      text: 'Hi {{name}}',
      createdAt: new Date()
    })
    const prisma = { template: { findFirst } } as unknown as PrismaService
    const repository = new TemplateRepository(prisma)

    const result = await repository.findByIdAndProjectId({ templateId: id.toString(), projectId: 'project-1' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template?.text).toBe('Hi {{name}}')
    expect(findFirst).toHaveBeenCalledWith({ where: { id: id.toString(), projectId: 'project-1' } })
  })

  it('returns { template: null } for a template owned by another project', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const prisma = { template: { findFirst } } as unknown as PrismaService
    const repository = new TemplateRepository(prisma)

    const result = await repository.findByIdAndProjectId({ templateId: validId().toString(), projectId: 'project-1' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template).toBeNull()
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- template.repository.unit`
Expected: PASS.

- [ ] **Step 8: Update the seed to consume `@ruguin/email-templates`**

Replace the full contents of `apps/core-server/prisma/seed.ts`:

```ts
import { randomBytes, randomUUID } from 'node:crypto'

import { PrismaPg } from '@prisma/adapter-pg'
import { renderWelcomeEmailTemplate } from '@ruguin/email-templates'

import { hashApiKey } from '../src/modules/api-keys/domain/hash-api-key'
import { PrismaClient } from '../src/shared/infrastructure/database/prisma/generated/client'

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL must be set to run the seed.')
  }

  /*
   * This app owns exactly one Postgres schema, core_server (see apps/core-server/CLAUDE.md) — a
   * DATABASE_URL missing ?schema= or pointing at a different one would silently seed into the
   * wrong place (Postgres defaults to `public`) rather than fail loudly.
   */
  const schema = new URL(connectionString).searchParams.get('schema')
  if (schema !== 'core_server') {
    throw new Error(`DATABASE_URL must include ?schema=core_server to run the seed (got: ${schema ?? 'none'}).`)
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) })

  const organization = await prisma.organization.create({ data: { name: 'Dev Organization' } })
  const project = await prisma.project.create({ data: { organizationId: organization.id, name: 'Dev Project' } })

  /*
   * Written directly, verifiedAt already set — bypasses the real SES CreateEmailIdentity call
   * (design spec decision 9 of the SenderIdentity plan) so dev/test never depends on AWS/LocalStack
   * actually confirming a mailbox that doesn't exist. Email randomized so re-running the seed
   * against the same database doesn't collide on SenderIdentity.email's global unique index.
   */
  const senderIdentity = await prisma.senderIdentity.create({
    data: {
      projectId: project.id,
      name: 'Dev Sender',
      email: `dev-sender+${randomUUID()}@ruguin.dev`,
      verifiedAt: new Date()
    }
  })

  /*
   * subject/html/text come from the React Email component (packages/email-templates), not a
   * hand-written literal — `{{name}}` is still literal text in all three, substituted per
   * recipient at send time by renderTemplate.
   */
  const welcomeTemplate = await renderWelcomeEmailTemplate()
  const template = await prisma.template.create({
    data: {
      projectId: project.id,
      senderIdentityId: senderIdentity.id,
      name: 'Welcome',
      subject: welcomeTemplate.subject,
      html: welcomeTemplate.html,
      text: welcomeTemplate.text
    }
  })

  /*
   * 32 bytes of entropy, hex-encoded — see design spec decision 9. Printed once; never
   * recoverable afterward, matching the guarantee that only its hash is ever persisted.
   */
  const rawApiKey = randomBytes(32).toString('hex')
  const hashedKey = hashApiKey({ rawKey: rawApiKey })
  await prisma.apiKey.create({ data: { projectId: project.id, hashedKey } })

  console.log('Seeded development data:')
  console.log(`  organizationId:   ${organization.id}`)
  console.log(`  projectId:        ${project.id}`)
  console.log(`  senderIdentityId: ${senderIdentity.id}`)
  console.log(`  templateId:       ${template.id}`)
  console.log(`  API key:          ${rawApiKey}`)
  console.log('This key is shown once. It is not recoverable — re-run the seed to mint a new one.')

  await prisma.$disconnect()
}

await main()
```

`apps/core-server`'s `package.json` needs `@ruguin/email-templates` added as a `dependency`:

```bash
pnpm --filter @ruguin/core-server add @ruguin/email-templates@workspace:*
```

- [ ] **Step 9: Rebuild `@ruguin/email-templates`, then verify the seed runs cleanly**

Run: `pnpm --filter @ruguin/email-templates build` (Global Constraints — this app consumes it via
`dist/`, a stale build would silently keep serving the old shape).
Then: `pnpm with-env pnpm --filter @ruguin/core-server exec tsx prisma/seed.ts`
Expected: prints all five values (`organizationId`, `projectId`, `senderIdentityId`, `templateId`,
`API key`) with no thrown error.

- [ ] **Step 10: Run the full core-server test suite and type check**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types`
Expected: unit and integration tests PASS. e2e tests are expected to still be RED after this task —
Task 8 rewrites the relevant assertion; do not attempt to fix e2e failures here.

- [ ] **Step 11: Commit**

```bash
git add apps/core-server packages/email-templates pnpm-lock.yaml
git commit -m "feat(core-server): add Template.text, generate the seeded template via React Email"
```

---

### Task 3: `Email.text`

**Files:**

- Modify: `apps/core-server/prisma/schema/email.prisma`
- Create: `apps/core-server/prisma/migrations/20260806080000_add_email_text/migration.sql`
- Modify: `apps/core-server/src/modules/emails/domain/models/email.model.ts`
- Test: `apps/core-server/src/modules/emails/domain/models/__tests__/email.model.unit.ts` (modify)
- Modify: `apps/core-server/src/modules/emails/infrastructure/database/prisma/email.repository.ts`
- Test: `apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.unit.ts` (modify)

**Interfaces:**

- Produces: `Email.create(input: {..., text: string, ...})` — the constructor parameter order
  becomes `(id, projectId, templateId, senderIdentityId, idempotencyKey, from, to, subject, html,
  text, createdAt)`, consumed by Task 7's `SendEmailUseCase`.

- [ ] **Step 1: Reset the local dev database (same reasoning as Task 2, Step 1)**

Run: `docker compose -f infrastructure/local/docker-compose.yml down -v postgres && docker compose -f infrastructure/local/docker-compose.yml up -d postgres`
Then reapply every prior migration and re-run the seed:
`pnpm with-env pnpm --filter @ruguin/core-server db:deploy && pnpm with-env pnpm --filter @ruguin/core-server exec tsx prisma/seed.ts`

- [ ] **Step 2: Update the Prisma schema**

Replace the full contents of `apps/core-server/prisma/schema/email.prisma`:

```prisma
model Email {
  id               String      @id @default(uuid(7))
  projectId        String
  templateId       String
  senderIdentityId String
  idempotencyKey   String?
  from             String
  to               String
  subject          String
  html             String
  text             String
  status           EmailStatus @default(QUEUED)
  createdAt        DateTime    @default(now())

  @@index([projectId])
  @@index([senderIdentityId])
  @@map("emails")
}

enum EmailStatus {
  QUEUED
}
```

- [ ] **Step 3: Write the migration by hand**

Create the directory `apps/core-server/prisma/migrations/20260806080000_add_email_text/` and inside
it `migration.sql`:

```sql
-- AlterTable
ALTER TABLE "emails" ADD COLUMN "text" TEXT NOT NULL;
```

Apply it: `pnpm with-env pnpm --filter @ruguin/core-server db:deploy`
Then regenerate the client: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 4: Update the failing model test**

Replace the full contents of `apps/core-server/src/modules/emails/domain/models/__tests__/email.model.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Email } from '../email.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Email.create', () => {
  it('builds an Email from valid input', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date('2026-08-06T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('rejects an empty templateId', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: '',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty senderIdentityId', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: '',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty "from"', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: '',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty "to"', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: '',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty subject', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: '',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty html', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '',
      text: 'Hello',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty text', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: '',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- email.model.unit`
Expected: FAIL — `Email.create` doesn't require `text` yet.

- [ ] **Step 5: Update the model**

Replace the full contents of `apps/core-server/src/modules/emails/domain/models/email.model.ts`:

```ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidEmailError } from '../errors/models/invalid-email.error'

export class Email {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly templateId: string,
    readonly senderIdentityId: string,
    readonly idempotencyKey: string | null,
    readonly from: string,
    readonly to: string,
    readonly subject: string,
    readonly html: string,
    readonly text: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    templateId: string
    senderIdentityId: string
    idempotencyKey: string | null
    from: string
    to: string
    subject: string
    html: string
    text: string
    createdAt: Date
  }): Either<InvalidEmailError, Email> {
    if (input.projectId.trim().length === 0) return failure(new InvalidEmailError({ reason: 'projectId is empty' }))
    if (input.templateId.trim().length === 0) return failure(new InvalidEmailError({ reason: 'templateId is empty' }))
    if (input.senderIdentityId.trim().length === 0) {
      return failure(new InvalidEmailError({ reason: 'senderIdentityId is empty' }))
    }
    if (input.from.trim().length === 0) return failure(new InvalidEmailError({ reason: '"from" is empty' }))
    if (input.to.trim().length === 0) return failure(new InvalidEmailError({ reason: '"to" is empty' }))
    if (input.subject.trim().length === 0) return failure(new InvalidEmailError({ reason: 'subject is empty' }))
    if (input.html.trim().length === 0) return failure(new InvalidEmailError({ reason: 'html is empty' }))
    if (input.text.trim().length === 0) return failure(new InvalidEmailError({ reason: 'text is empty' }))

    return success(
      new Email(
        input.id,
        input.projectId,
        input.templateId,
        input.senderIdentityId,
        input.idempotencyKey,
        input.from,
        input.to,
        input.subject,
        input.html,
        input.text,
        input.createdAt
      )
    )
  }
}
```

- [ ] **Step 6: Run the model test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- email.model.unit`
Expected: PASS (9 tests).

- [ ] **Step 7: Update the repository and its test**

Replace the full contents of `apps/core-server/src/modules/emails/infrastructure/database/prisma/email.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type Prisma } from '../../../../../shared/infrastructure/database/prisma/generated/client'
import { type EmailRepository as EmailRepositoryContract } from '../../../domain/contracts/repositories/email.repository'
import { CreateEmailError } from '../../../domain/errors/models/create-email.error'
import { EmailIdempotencyConflictError } from '../../../domain/errors/models/email-idempotency-conflict.error'
import { InvalidEmailError } from '../../../domain/errors/models/invalid-email.error'
import { Email } from '../../../domain/models/email.model'

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

@Injectable()
export class EmailRepository implements EmailRepositoryContract {
  private toDomain(row: {
    id: string
    projectId: string
    templateId: string
    senderIdentityId: string
    idempotencyKey: string | null
    from: string
    to: string
    subject: string
    html: string
    text: string
    createdAt: Date
  }): Either<InvalidEmailError, Email> {
    const idResult = ID.validate({ id: row.id, modelName: 'Email' })
    if (idResult.isFailure()) return failure(new InvalidEmailError({ reason: idResult.value.message }))

    return Email.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      templateId: row.templateId,
      senderIdentityId: row.senderIdentityId,
      idempotencyKey: row.idempotencyKey,
      from: row.from,
      to: row.to,
      subject: row.subject,
      html: row.html,
      text: row.text,
      createdAt: row.createdAt
    })
  }

  /*
   * Split out of createIfNotExists to keep that method's cognitive complexity within the repo's
   * linter budget — this is exactly the recovery path a P2002 on the insert falls into, so it
   * only ever runs from that one catch block, never called directly by a use case.
   */
  private async recoverFromUniqueViolation(input: {
    client: Prisma.TransactionClient
    savepoint: string
    email: Email
    originalError: unknown
  }): Promise<Either<CreateEmailError | EmailIdempotencyConflictError, { email: Email; created: boolean }>> {
    const { client, savepoint, email, originalError } = input

    try {
      await client.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    } catch (rollbackError: unknown) {
      return failure(new CreateEmailError({ error: rollbackError }))
    }

    /*
     * A NULL idempotencyKey never matches the partial index's WHERE clause (it only covers
     * idempotencyKey IS NOT NULL), so a P2002 here can only be a primary-key collision on `id`
     * — astronomically unlikely with UUIDv7, but silently wrong if mishandled: falling through
     * to the recovery query below with idempotencyKey: null would return an ARBITRARY earlier
     * email in this project that also has no idempotency key, report a stranger's id as
     * "already sent this request", and silently drop the real send.
     */
    const { idempotencyKey } = email
    if (idempotencyKey === null) return failure(new CreateEmailError({ error: originalError }))

    /*
     * Lost the race on (projectId, idempotencyKey): the winner's row is what the caller must
     * treat as the result — never a second outbox event for the same logical request. The
     * partial index guarantees at most one row exists here, so findFirst is not itself racy.
     * Wrapped like the ROLLBACK call above it: a rejected read here is the same class of infra
     * failure and must resolve to Either, never escape as a thrown rejection.
     */
    let existingRow: Awaited<ReturnType<typeof client.email.findFirst>>
    try {
      existingRow = await client.email.findFirst({ where: { projectId: email.projectId, idempotencyKey } })
    } catch (findError: unknown) {
      return failure(new CreateEmailError({ error: findError }))
    }
    if (existingRow === null) return failure(new CreateEmailError({ error: originalError }))

    const mapped = this.toDomain(existingRow)
    if (mapped.isFailure()) return failure(new CreateEmailError({ error: mapped.value }))

    /*
     * Replay only means "same request sent twice"; the same key over a DIFFERENT body is a
     * client bug, and answering it with the first email's id would report success for a message
     * that is never queued and never sent — silent, permanent loss. Compared on the resolved
     * from/to/subject/html/text because those are what was persisted and what a replay would
     * re-send: templateId + variables have already been rendered into subject/html/text by the
     * use case.
     */
    const isSameRequest =
      mapped.value.from === email.from &&
      mapped.value.to === email.to &&
      mapped.value.subject === email.subject &&
      mapped.value.html === email.html &&
      mapped.value.text === email.text
    if (!isSameRequest) return failure(new EmailIdempotencyConflictError({ idempotencyKey }))

    return success({ email: mapped.value, created: false })
  }

  public async createIfNotExists(input: {
    email: Email
    tx: TransactionContext
  }): Promise<Either<CreateEmailError | EmailIdempotencyConflictError, { email: Email; created: boolean }>> {
    const client = input.tx as unknown as Prisma.TransactionClient
    const savepoint = `create_email_${input.email.id.toString().replaceAll('-', '_')}`

    try {
      /*
       * Postgres marks the whole enclosing transaction as aborted the instant the unique-index
       * insert fails — every statement after it, including the recovery findFirst in
       * recoverFromUniqueViolation, would error with 25P02 ("current transaction is aborted")
       * unless it first rolls back to a savepoint taken before the insert. Issued inside this
       * try: a network failure on the SAVEPOINT call itself is the same class of infra failure as
       * the insert failing, and this method's contract (Either, never a thrown rejection) must
       * hold for it too. The savepoint name is derived from the row's own id so concurrent
       * createIfNotExists calls sharing this transaction (none today, but nothing stops a future
       * orchestration use case) never collide on the savepoint stack.
       */
      await client.$executeRawUnsafe(`SAVEPOINT ${savepoint}`)

      const row = await client.email.create({
        data: {
          id: input.email.id.toString(),
          projectId: input.email.projectId,
          templateId: input.email.templateId,
          senderIdentityId: input.email.senderIdentityId,
          idempotencyKey: input.email.idempotencyKey,
          from: input.email.from,
          to: input.email.to,
          subject: input.email.subject,
          html: input.email.html,
          text: input.email.text
        }
      })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new CreateEmailError({ error: mapped.value }))

      return success({ email: mapped.value, created: true })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) return failure(new CreateEmailError({ error }))

      return this.recoverFromUniqueViolation({ client, savepoint, email: input.email, originalError: error })
    }
  }
}
```

Replace the full contents of `apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.unit.ts`:

```ts
import { ID, StatusError } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type TransactionContext } from '../../../../../../shared/domain/contracts/transaction-context.contract'
import { EmailIdempotencyConflictError } from '../../../../domain/errors/models/email-idempotency-conflict.error'
import { Email } from '../../../../domain/models/email.model'
import { EmailRepository } from '../email.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail(idempotencyKey: string | null, overrides: Partial<{ to: string; subject: string }> = {}) {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: 'template-1',
    senderIdentityId: 'sender-1',
    idempotencyKey,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Hello</p>',
    text: 'Hello',
    createdAt: new Date('2026-08-04T00:00:00Z'),
    ...overrides
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

class UniqueConstraintViolation extends Error {
  readonly code = 'P2002'
  constructor() {
    super('Unique constraint failed')
    this.name = 'PrismaClientKnownRequestError'
  }
}

function createTxStub(input: {
  create: (data: Record<string, unknown>) => Promise<unknown>
  findFirst?: () => Promise<unknown>
  executeRawUnsafe?: (query: string) => Promise<unknown>
}): { tx: TransactionContext; findFirst: ReturnType<typeof vi.fn>; executeRawUnsafe: ReturnType<typeof vi.fn> } {
  /*
   * The repository issues SAVEPOINT/ROLLBACK TO SAVEPOINT around the insert to survive Postgres
   * aborting the transaction on a real unique-violation; that recovery is exercised against a
   * real database in email.repository.int.ts. Mocked to a no-op here by default, but exposed as
   * a spy so a test can both assert it was called and inject a failure from it.
   */
  const executeRawUnsafe = vi.fn(input.executeRawUnsafe ?? (() => Promise.resolve(0)))
  const findFirst = vi.fn(input.findFirst ?? (() => Promise.resolve(null)))
  const tx = {
    $executeRawUnsafe: executeRawUnsafe,
    email: {
      create: ({ data }: { data: Record<string, unknown> }) => input.create(data),
      findFirst
    }
  } as unknown as TransactionContext

  return { executeRawUnsafe, findFirst, tx }
}

describe('EmailRepository#createIfNotExists', () => {
  it('returns created: true and the persisted row on a fresh insert', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: (data) =>
        Promise.resolve({
          id: data.id,
          projectId: data.projectId,
          templateId: data.templateId,
          senderIdentityId: data.senderIdentityId,
          idempotencyKey: data.idempotencyKey,
          from: data.from,
          to: data.to,
          subject: data.subject,
          html: data.html,
          text: data.text,
          createdAt: email.createdAt
        })
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.created).toBe(true)
      expect(result.value.email.id.toString()).toBe(email.id.toString())
    }
  })

  it('returns created: false and the pre-existing row when the partial unique index rejects the insert', async () => {
    const email = buildEmail('idem-1')
    const existingRow = {
      id: '0198f3b2-1234-7000-8000-000000000099',
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: 'idem-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date('2026-08-04T00:00:00Z')
    }
    const repository = new EmailRepository()
    const { findFirst, tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () => Promise.resolve(existingRow)
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.created).toBe(false)
      expect(result.value.email.id.toString()).toBe(existingRow.id)
    }
    /*
     * The recovery read has to be scoped by projectId in the query itself — looking the row up by
     * idempotencyKey alone would hand one tenant another tenant's email as its own replay.
     */
    expect(findFirst).toHaveBeenCalledWith({ where: { projectId: 'project-1', idempotencyKey: 'idem-1' } })
  })

  it('returns EmailIdempotencyConflictError when the key was already used with a different body', async () => {
    /*
     * Same key, different content: returning the pre-existing row as a successful replay would
     * report 202 for a message that is never queued and never sent — silent, permanent loss.
     */
    const email = buildEmail('idem-1', { to: 'someone-else@example.com', subject: 'Different subject' })
    const existingRow = {
      id: '0198f3b2-1234-7000-8000-000000000099',
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: 'idem-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date('2026-08-04T00:00:00Z')
    }
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () => Promise.resolve(existingRow)
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value).toBeInstanceOf(EmailIdempotencyConflictError)
      expect(result.value.status).toBe(StatusError.CONFLICT)
    }
  })

  it('treats a replay whose only difference is the rendered text as a conflict', async () => {
    /*
     * text is compared post-render, same reasoning already applied to html: two requests with the
     * same templateId but different variables are different emails, even if subject/html happen
     * to match.
     */
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () =>
        Promise.resolve({
          id: '0198f3b2-1234-7000-8000-000000000099',
          projectId: 'project-1',
          templateId: '0198f3b2-1234-7000-8000-000000000020',
          senderIdentityId: 'sender-1',
          idempotencyKey: 'idem-1',
          from: 'sender@example.com',
          to: 'recipient@example.com',
          subject: 'Hello',
          html: '<p>Hello</p>',
          text: 'Hello, Ada',
          createdAt: new Date('2026-08-04T00:00:00Z')
        })
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(EmailIdempotencyConflictError)
  })

  it('treats a replay whose only difference is the rendered html as a conflict', async () => {
    /*
     * html is compared post-render, because that is what was persisted and what a replay would
     * re-send: two requests with the same templateId but different variables are different emails.
     */
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () =>
        Promise.resolve({
          id: '0198f3b2-1234-7000-8000-000000000099',
          projectId: 'project-1',
          templateId: '0198f3b2-1234-7000-8000-000000000020',
          senderIdentityId: 'sender-1',
          idempotencyKey: 'idem-1',
          from: 'sender@example.com',
          to: 'recipient@example.com',
          subject: 'Hello',
          html: '<p>Hello, Ada</p>',
          text: 'Hello',
          createdAt: new Date('2026-08-04T00:00:00Z')
        })
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(EmailIdempotencyConflictError)
  })

  it('maps any other thrown error into CreateEmailError', async () => {
    const email = buildEmail(null)
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new Error('connection terminated unexpectedly')
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })

  it('returns failure without querying findFirst when a P2002 fires and the email has no idempotencyKey', async () => {
    /*
     * A NULL idempotencyKey can never match the partial index's WHERE clause, so a P2002 here
     * can only be a primary-key collision, never a lost idempotency race — findFirst must never
     * run, or it could hand back an unrelated email as if it were "already sent this request".
     */
    const email = buildEmail(null)
    const repository = new EmailRepository()
    const { findFirst, tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('returns failure, not a thrown rejection, when the SAVEPOINT call itself fails', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => Promise.resolve({}),
      executeRawUnsafe: () => Promise.reject(new Error('connection terminated unexpectedly'))
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })

  it('returns failure, not a thrown rejection, when the ROLLBACK TO SAVEPOINT call itself fails', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    let isSavepointTaken = false
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      executeRawUnsafe: () => {
        /*
         * First call is the SAVEPOINT before the insert — let it succeed. Only the
         * ROLLBACK TO SAVEPOINT that follows the P2002 catch should fail.
         */
        if (!isSavepointTaken) {
          isSavepointTaken = true
          return Promise.resolve(0)
        }
        return Promise.reject(new Error('connection terminated unexpectedly'))
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })
})
```

The one new test (`'treats a replay whose only difference is the rendered text as a conflict'`)
mirrors the existing html one exactly, proving `text` is now part of the same-request comparison.

Run: `pnpm --filter @ruguin/core-server test -- email.repository.unit`
Expected: PASS (9 tests).

- [ ] **Step 8: Run the full core-server type check**

Run: `pnpm --filter @ruguin/core-server check:types`
Expected: FAIL — `send-email.use-case.ts`, `send-email.use-case.unit.ts`, and
`email.controller.unit.ts` still call `Email.create`/build payloads without `text`. This is expected
— Task 7 fixes every remaining call site. Confirm the failure is limited to exactly these files (or
their equivalents); do not fix them here.

- [ ] **Step 9: Commit**

```bash
git add apps/core-server
git commit -m "feat(core-server): require Email.text, compare it in idempotency recovery"
```

---

### Task 4: `renderTemplate` — third field

**Files:**

- Modify: `apps/core-server/src/modules/templates/domain/render-template.ts`
- Test: `apps/core-server/src/modules/templates/domain/__tests__/render-template.unit.ts` (modify)

**Interfaces:**

- Produces: `renderTemplate(input: { subject, html, text, variables }): Either<MissingTemplateVariableError, { subject, html, text }>` — consumed by Task 7's `SendEmailUseCase`.

- [ ] **Step 1: Update the failing test**

Replace the full contents of `apps/core-server/src/modules/templates/domain/__tests__/render-template.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { renderTemplate } from '../render-template'

describe('renderTemplate', () => {
  it('substitutes every {{variable}} occurrence in subject, html, and text', () => {
    const result = renderTemplate({
      subject: 'Hi {{name}}',
      html: '<p>Welcome, {{name}}! Your plan is {{plan}}.</p>',
      text: 'Welcome, {{name}}! Your plan is {{plan}}.',
      variables: { name: 'Ada', plan: 'Pro' }
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.subject).toBe('Hi Ada')
      expect(result.value.html).toBe('<p>Welcome, Ada! Your plan is Pro.</p>')
      expect(result.value.text).toBe('Welcome, Ada! Your plan is Pro.')
    }
  })

  it('fails explicitly when a variable referenced only in text is missing', () => {
    const result = renderTemplate({
      subject: 'Hi',
      html: '<p>ok</p>',
      text: 'Hi {{name}}',
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
  })

  it('fails explicitly when a referenced variable is missing, never emitting the literal placeholder', () => {
    const result = renderTemplate({ subject: 'Hi {{name}}', html: '<p>ok</p>', text: 'ok', variables: {} })

    expect(result.isFailure()).toBe(true)
  })

  it('is a no-op when the template has no placeholders', () => {
    const result = renderTemplate({ subject: 'Hello', html: '<p>Hello</p>', text: 'Hello', variables: {} })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value).toEqual({ subject: 'Hello', html: '<p>Hello</p>', text: 'Hello' })
    }
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- render-template.unit`
Expected: FAIL — `renderTemplate` doesn't accept/require `text` yet.

- [ ] **Step 2: Update `renderTemplate`**

Replace the full contents of `apps/core-server/src/modules/templates/domain/render-template.ts`:

```ts
import { type Either, failure, success } from '@ruguin/utils'

import { MissingTemplateVariableError } from './errors/missing-template-variable.error'

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g

function substitute(text: string, variables: Record<string, string>): Either<MissingTemplateVariableError, string> {
  let missingVariableName: string | undefined

  const replaced = text.replaceAll(VARIABLE_PATTERN, (_match, variableName: string) => {
    /*
     * Once one variable is known missing, stop substituting — the placeholder itself is
     * irrelevant, this branch only exists to short-circuit the remaining replacements cheaply.
     */
    if (missingVariableName !== undefined) return ''

    /*
     * Object.hasOwn, not `variables[variableName] === undefined`: a plain object literal
     * inherits from Object.prototype, so a template referencing {{toString}} or
     * {{constructor}} would otherwise resolve to a prototype method (a function, not
     * undefined) and slip past the missing-variable check entirely.
     */
    if (!Object.hasOwn(variables, variableName)) {
      missingVariableName = variableName
      return ''
    }

    // Object.hasOwn just confirmed the key is present; noUncheckedIndexedAccess can't see that.
    return variables[variableName]!
  })

  if (missingVariableName !== undefined) {
    return failure(new MissingTemplateVariableError({ variableName: missingVariableName }))
  }

  return success(replaced)
}

export function renderTemplate(input: {
  subject: string
  html: string
  text: string
  variables: Record<string, string>
}): Either<MissingTemplateVariableError, { subject: string; html: string; text: string }> {
  const subjectResult = substitute(input.subject, input.variables)
  if (subjectResult.isFailure()) return failure(subjectResult.value)

  const htmlResult = substitute(input.html, input.variables)
  if (htmlResult.isFailure()) return failure(htmlResult.value)

  const textResult = substitute(input.text, input.variables)
  if (textResult.isFailure()) return failure(textResult.value)

  return success({ subject: subjectResult.value, html: htmlResult.value, text: textResult.value })
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- render-template.unit`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/core-server
git commit -m "feat(core-server): thread text through renderTemplate"
```

---

### Task 5: `TemplateCacheProvider`

**Files:**

- Create: `apps/core-server/src/modules/templates/domain/contracts/template-cache.provider.ts`
- Create: `apps/core-server/src/modules/templates/infrastructure/cache/template-cache.provider.ts`
- Test: `apps/core-server/src/modules/templates/infrastructure/cache/__tests__/template-cache.provider.unit.ts`
- Modify: `apps/core-server/src/modules/templates/templates.module.ts`
- Modify: `packages/env/src/apps/core-server.environment.ts`

**Interfaces:**

- Consumes: `TEMPLATE_LOOKUP_PROVIDER`/`TemplateLookupProvider` (existing), `GET_OR_SET_CACHE_PROVIDER`/`DELETE_CACHE_PROVIDER` from `@ruguin/cache` (existing, already used by `SenderIdentityCacheProvider`).
- Produces: `TEMPLATE_CACHE_PROVIDER` token, `TemplateCacheProvider` interface (`get`, `invalidate`) — consumed by Task 7's `SendEmailUseCase`.

- [ ] **Step 1: Add `TEMPLATE_CACHE_TTL_IN_SECONDS` to `coreServerENV`**

Replace the full contents of `packages/env/src/apps/core-server.environment.ts`:

```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { awsENV } from '../packages/aws.environment.ts'
import { cacheENV } from '../packages/cache.environment.ts'
import { databaseENV } from '../packages/database.environment.ts'
import { docsENV } from '../packages/docs.environment.ts'
import { messageBrokerENV } from '../packages/message-broker.environment.ts'
import { lazyEnvironment } from '../shared/lazy-environment.ts'
import { serverENV } from '../shared/server.environment.ts'

/*
 * core-server's single typed env entry point: every package this app actually depends on,
 * composed via `extends` instead of scattering separate imports across its call sites. Add a new
 * `extends` entry here — never a new field under `server` — when the app starts using another
 * @ruguin/env package; `server` stays empty unless core-server needs a variable no existing
 * package already owns.
 */
export const coreServerENV = lazyEnvironment(() =>
  createEnv({
    server: {
      /*
       * How long a resolved (projectId, organizationId) tuple for a given API key stays cached.
       * Revoking a key has no effect until this expires — accepted explicitly by ticket EMAIL-3.
       */
      API_KEY_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300),
      SENDER_IDENTITY_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300),
      /*
       * How long a resolved Template stays cached in the send hot path. No active invalidation
       * exists yet (Template has no write path beyond seed) — this TTL is the only staleness
       * bound today; TemplateCacheProvider.invalidate() is ready for whenever a Template CRUD
       * endpoint calls it.
       */
      TEMPLATE_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300)
    },
    extends: [serverENV, databaseENV, cacheENV, messageBrokerENV, docsENV, awsENV],
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

- [ ] **Step 2: Rebuild `@ruguin/env`**

Run: `pnpm --filter @ruguin/env build`
`@ruguin/env` is consumed via its built `dist/` — every app importing `coreServerENV` needs the
rebuilt output before `TEMPLATE_CACHE_TTL_IN_SECONDS` is visible to them (Global Constraints).

- [ ] **Step 3: Write the contract**

Create `apps/core-server/src/modules/templates/domain/contracts/template-cache.provider.ts`:

```ts
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { type Template } from '../models/template.model'

export const TEMPLATE_CACHE_PROVIDER = Symbol('TEMPLATE_CACHE_PROVIDER')

export interface TemplateCacheProvider {
  get(input: { templateId: string; projectId: string }): Promise<Either<BaseError, Template | null>>
  invalidate(input: { templateId: string }): Promise<void>
}
```

- [ ] **Step 4: Write the failing cache provider test**

Create `apps/core-server/src/modules/templates/infrastructure/cache/__tests__/template-cache.provider.unit.ts`:

```ts
import { CacheLockOutcome, CacheSource, type IDeleteCacheProvider, type IGetOrSetCacheProvider } from '@ruguin/cache'
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type TemplateLookupProvider } from '../../../domain/contracts/template-lookup.provider'
import { FindTemplateError } from '../../../domain/errors/find-template.error'
import { Template } from '../../../domain/models/template.model'
import { TemplateCacheProvider } from '../template-cache.provider'

/*
 * The provider reads coreServerENV.TEMPLATE_CACHE_TTL_IN_SECONDS on every call, and coreServerENV
 * is one combined schema validated in full on first property access — same reasoning as
 * sender-identity-cache.provider.unit.ts's own beforeAll block.
 */
beforeAll(() => {
  vi.stubEnv('ENVIRONMENT', 'test')
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/ruguin?schema=core_server')
  vi.stubEnv('CACHE_PREFIX', 'ruguin:core-server')
  vi.stubEnv('KAFKA_BOOTSTRAP_BROKERS', 'localhost:9092')
  vi.stubEnv('DOCS_USERNAME', 'admin')
  vi.stubEnv('DOCS_PASSWORD', 'super-secret')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

function validId(): ID {
  const generated = ID.generate({ modelName: 'Template' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildTemplate() {
  const result = Template.create({
    id: validId(),
    projectId: 'project-1',
    senderIdentityId: 'sender-1',
    name: 'Welcome',
    subject: 'Hi {{name}}',
    html: '<p>Hi {{name}}</p>',
    text: 'Hi {{name}}',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function createGetOrSetStub(): IGetOrSetCacheProvider {
  return {
    getOrSet: vi.fn(async ({ loader }) => {
      const loaded = await loader()
      if (loaded.isFailure()) return failure(loaded.value)

      return success({ value: loaded.value, source: CacheSource.LOADER, lockOutcome: CacheLockOutcome.NOT_ATTEMPTED })
    })
  } as unknown as IGetOrSetCacheProvider
}

/*
 * Simulates what every real ICacheDriver (including 'memory') actually does: the first getOrSet
 * call is a miss that stores the loader's return value; every call after that is a hit that
 * replays it through a JSON round-trip, exactly like JsonSerializerStrategy's
 * serialize()/deserialize() does — stripping the Template prototype. `createGetOrSetStub` above
 * never round-trips anything, so it could not have caught the bug this reproduces.
 */
function createGetOrSetStubWithSerializationRoundTrip(): IGetOrSetCacheProvider {
  let stored: unknown

  return {
    getOrSet: vi.fn(async ({ loader }) => {
      if (stored !== undefined) {
        // eslint-disable-next-line unicorn/prefer-structured-clone -- must be JSON, not structuredClone: structuredClone keeps this reproduction faithful to the real driver's string round-trip.
        const rehydratedFromJson: unknown = JSON.parse(JSON.stringify(stored))
        return success({
          value: rehydratedFromJson,
          source: CacheSource.CACHE,
          lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
        })
      }

      const loaded = await loader()
      if (loaded.isFailure()) return failure(loaded.value)

      stored = loaded.value
      return success({ value: loaded.value, source: CacheSource.LOADER, lockOutcome: CacheLockOutcome.NOT_ATTEMPTED })
    })
  } as unknown as IGetOrSetCacheProvider
}

describe('TemplateCacheProvider', () => {
  describe('get', () => {
    it('runs the loader through getOrSet, keyed by the template id, with a colon-free namespace', async () => {
      const template = buildTemplate()
      const lookup = {
        findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template }))
      } as unknown as TemplateLookupProvider
      const cache = createGetOrSetStub()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      const result = await cacheProvider.get({ templateId: template.id.toString(), projectId: 'project-1' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value?.text).toBe('Hi {{name}}')
      const [options] = (cache.getOrSet as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { key: string; namespace: string; ttlInMs: number }
      ]
      expect(options.key).toBe(template.id.toString())
      expect(options.namespace).not.toMatch(/[\s:]/)
      expect(Number.isSafeInteger(options.ttlInMs)).toBe(true)
    })

    it('propagates a lookup failure through the loader', async () => {
      const lookup = {
        findByIdAndProjectId: vi.fn().mockResolvedValue(failure(new FindTemplateError({})))
      } as unknown as TemplateLookupProvider
      const cache = createGetOrSetStub()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      const result = await cacheProvider.get({ templateId: 'template-1', projectId: 'project-1' })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value).toBeInstanceOf(FindTemplateError)
    })

    it('resolves null when the lookup finds no matching row', async () => {
      const lookup = {
        findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template: null }))
      } as unknown as TemplateLookupProvider
      const cache = createGetOrSetStub()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      const result = await cacheProvider.get({ templateId: 'unknown', projectId: 'project-1' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value).toBeNull()
    })

    it('rehydrates a real Template instance from a cache hit, so text stays readable after the JSON round-trip', async () => {
      const template = buildTemplate()
      const findByIdAndProjectIdMock = vi.fn().mockResolvedValue(success({ template }))
      const lookup = { findByIdAndProjectId: findByIdAndProjectIdMock } as unknown as TemplateLookupProvider
      const cache = createGetOrSetStubWithSerializationRoundTrip()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      const first = await cacheProvider.get({ templateId: template.id.toString(), projectId: 'project-1' })
      const second = await cacheProvider.get({ templateId: template.id.toString(), projectId: 'project-1' })

      expect(findByIdAndProjectIdMock).toHaveBeenCalledOnce()
      expect(first.isSuccess()).toBe(true)
      expect(second.isSuccess()).toBe(true)
      if (first.isSuccess() && second.isSuccess()) {
        expect(first.value).toBeInstanceOf(Template)
        expect(second.value).toBeInstanceOf(Template)
        // The bug this guards against: a plain, deserialized object has this as a field, not a Template method.
        expect(second.value?.text).toBe('Hi {{name}}')
        expect(second.value?.id.toString()).toBe(template.id.toString())
      }
    })
  })

  describe('invalidate', () => {
    it('calls delete with the same namespace used by get', async () => {
      const lookup = { findByIdAndProjectId: vi.fn() } as unknown as TemplateLookupProvider
      const cache = { getOrSet: vi.fn() } as unknown as IGetOrSetCacheProvider
      const deleteFunction = vi.fn().mockResolvedValue(success({ existed: true }))
      const cacheInvalidator = { delete: deleteFunction } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      await cacheProvider.invalidate({ templateId: 'template-1' })

      expect(deleteFunction).toHaveBeenCalledWith({ key: 'template-1', namespace: 'core-server-template' })
    })
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- template-cache.provider`
Expected: FAIL — `../template-cache.provider` does not exist yet.

- [ ] **Step 6: Write the cache provider**

Create `apps/core-server/src/modules/templates/infrastructure/cache/template-cache.provider.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import {
  DELETE_CACHE_PROVIDER,
  GET_OR_SET_CACHE_PROVIDER,
  type IDeleteCacheProvider,
  type IGetOrSetCacheProvider
} from '@ruguin/cache'
import { coreServerENV } from '@ruguin/env'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { TEMPLATE_LOOKUP_PROVIDER, type TemplateLookupProvider } from '../../domain/contracts/template-lookup.provider'
import { type TemplateCacheProvider as TemplateCacheProviderContract } from '../../domain/contracts/template-cache.provider'
import { FindTemplateError } from '../../domain/errors/find-template.error'
import { Template } from '../../domain/models/template.model'

// KeyBuilder.validateSegment forbids ':' in namespace/key segments — see packages/cache/src/infra/key-builder.ts.
const CACHE_NAMESPACE = 'core-server-template'

@Injectable()
export class TemplateCacheProvider implements TemplateCacheProviderContract {
  constructor(
    @Inject(TEMPLATE_LOOKUP_PROVIDER) private readonly lookup: TemplateLookupProvider,
    @Inject(GET_OR_SET_CACHE_PROVIDER) private readonly cache: IGetOrSetCacheProvider,
    @Inject(DELETE_CACHE_PROVIDER) private readonly cacheInvalidator: IDeleteCacheProvider
  ) {}

  public async get(input: {
    templateId: string
    projectId: string
  }): Promise<Either<FindTemplateError, Template | null>> {
    const cached = await this.cache.getOrSet<Template, FindTemplateError>({
      key: input.templateId,
      namespace: CACHE_NAMESPACE,
      ttlInMs: coreServerENV.TEMPLATE_CACHE_TTL_IN_SECONDS * 1000,
      loader: async () => {
        const result = await this.lookup.findByIdAndProjectId({
          templateId: input.templateId,
          projectId: input.projectId
        })
        if (result.isFailure()) return failure(result.value)
        return success(result.value.template)
      }
    })

    if (cached.isFailure()) return failure(cached.value)
    if (cached.value.value === null) return success(null)

    /*
     * getOrSet's cache HIT path round-trips every driver — including 'memory' — through
     * ISerializerStrategy (JSON.stringify/parse), which strips the Template prototype: the value
     * is a plain object shaped like Template, not an instance. Rehydrating unconditionally (hit or
     * miss) means both paths return the exact same guarantee — same bug class already found and
     * fixed in SenderIdentityCacheProvider (prior plan, Task 13).
     */
    return this.toDomain(cached.value.value)
  }

  private toDomain(raw: Template): Either<FindTemplateError, Template> {
    const idResult = ID.validate({ id: raw.id.value, modelName: 'Template' })
    if (idResult.isFailure()) return failure(new FindTemplateError({ error: idResult.value }))

    const created = Template.create({
      id: idResult.value.idValidated,
      projectId: raw.projectId,
      senderIdentityId: raw.senderIdentityId,
      name: raw.name,
      subject: raw.subject,
      html: raw.html,
      text: raw.text,
      createdAt: new Date(raw.createdAt)
    })
    if (created.isFailure()) return failure(new FindTemplateError({ error: created.value }))

    return success(created.value)
  }

  public async invalidate(input: { templateId: string }): Promise<void> {
    /*
     * Fire-and-forget: nothing writes a Template today (seed only), so this method has no caller
     * yet — included for symmetry with SenderIdentityCacheProvider, ready for whenever Template
     * gets a write path. A failed cache delete just means the stale value survives until its own
     * TTL expires, not incorrect data loss.
     */
    await this.cacheInvalidator.delete({ key: input.templateId, namespace: CACHE_NAMESPACE })
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- template-cache.provider`
Expected: PASS (5 tests).

- [ ] **Step 8: Wire the cache provider into the module**

Replace the full contents of `apps/core-server/src/modules/templates/templates.module.ts`:

```ts
import { Module } from '@nestjs/common'

import { TEMPLATE_CACHE_PROVIDER } from './domain/contracts/template-cache.provider'
import { TEMPLATE_LOOKUP_PROVIDER } from './domain/contracts/template-lookup.provider'
import { TemplateCacheProvider } from './infrastructure/cache/template-cache.provider'
import { TemplateRepository } from './infrastructure/database/prisma/template.repository'

@Module({
  providers: [
    TemplateRepository,
    { provide: TEMPLATE_LOOKUP_PROVIDER, useExisting: TemplateRepository },
    TemplateCacheProvider,
    { provide: TEMPLATE_CACHE_PROVIDER, useExisting: TemplateCacheProvider }
  ],
  exports: [TEMPLATE_LOOKUP_PROVIDER, TEMPLATE_CACHE_PROVIDER]
})
export class TemplatesModule {}
```

`TEMPLATE_LOOKUP_PROVIDER` stays exported — `TemplateCacheProvider` needs it injected, and nothing
about that changes what other modules importing `TemplatesModule` can already see.

- [ ] **Step 9: Run the full core-server test suite and type check**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types`
Expected: unit tests PASS. The `check:types` failures already expected from Task 3
(`send-email.use-case.ts` and friends) are unchanged by this task — do not fix them here.

- [ ] **Step 10: Commit**

```bash
git add apps/core-server packages/env
git commit -m "feat(core-server): add TemplateCacheProvider"
```

---

### Task 6: `EmailSendRequestedPayloadSchema` + dispatch-worker — thread `text`

**Files:**

- Modify: `packages/event-schemas/src/email-send-requested.schema.ts`
- Test: `packages/event-schemas/src/__tests__/email-send-requested.schema.unit.ts` (modify)
- Modify: `apps/dispatch-worker/src/email/application/providers/email-sender.port.ts`
- Modify: `apps/dispatch-worker/src/email/application/use-cases/send-email.use-case.ts`
- Test: `apps/dispatch-worker/src/email/application/use-cases/__tests__/send-email.use-case.unit.ts` (modify)
- Modify: `apps/dispatch-worker/src/email/infra/ses/ses-email-sender.ts`
- Test: `apps/dispatch-worker/src/email/infra/ses/__tests__/ses-email-sender.unit.ts` (modify)

**Interfaces:**

- Produces: `EmailSendRequestedPayloadSchema` gains `text: z.string().min(1)`; `SendEmailInput`
  (dispatch-worker's port) and `SendEmailUseCaseInput` both gain `text: string` — consumed by
  Task 7's `SendEmailUseCase` (core-server), which is the producer of the payload this schema
  validates.

- [ ] **Step 1: Update the failing event schema test**

In `packages/event-schemas/src/__tests__/email-send-requested.schema.unit.ts`, replace the
`validPayload` constant and add one test. Replace the full file contents:

```ts
import { describe, expect, it } from 'vitest'

import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_RETRY_TOPIC,
  EMAIL_SEND_REQUESTED_TOPIC,
  EmailSendRequestedPayloadSchema
} from '../email-send-requested.schema.ts'
import { createMessageEnvelopeSchema } from '../message-envelope.schema.ts'

describe('EmailSendRequestedPayloadSchema', () => {
  const validPayload = {
    emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
    organizationId: '018f9a9e-6f0a-7c3e-9b0a-000000000002',
    projectId: '018f9a9e-6f0a-7c3e-9b0a-000000000003',
    from: 'sender@ruguin.dev',
    to: 'recipient@ruguin.dev',
    subject: 'Welcome',
    html: '<p>Hi</p>',
    text: 'Hi'
  }

  it('accepts a valid payload', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse(validPayload)

    expect(result.success).toBe(true)
  })

  it('accepts a valid payload with an optional idempotencyKey', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse({ ...validPayload, idempotencyKey: 'idem-1' })

    expect(result.success).toBe(true)
  })

  it('accepts a valid payload with an optional fromName', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse({ ...validPayload, fromName: 'Will Gravina' })

    expect(result.success).toBe(true)
  })

  it('rejects a payload missing a required field', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,sonarjs/no-unused-vars -- intentionally destructure subject to test exclusion
    const { subject: _subject, ...withoutSubject } = validPayload

    const result = EmailSendRequestedPayloadSchema.safeParse(withoutSubject)

    expect(result.success).toBe(false)
  })

  it('rejects a payload missing text', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,sonarjs/no-unused-vars -- intentionally destructure text to test exclusion
    const { text: _text, ...withoutText } = validPayload

    const result = EmailSendRequestedPayloadSchema.safeParse(withoutText)

    expect(result.success).toBe(false)
  })

  it('rejects an invalid "from" email address', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse({ ...validPayload, from: 'not-an-email' })

    expect(result.success).toBe(false)
  })

  it('validates against the generic envelope', () => {
    const envelopeSchema = createMessageEnvelopeSchema(EmailSendRequestedPayloadSchema)

    const result = envelopeSchema.safeParse({
      eventId: '018f9a9e-6f0a-7c3e-9b0a-000000000004',
      name: 'email.send.requested',
      payload: validPayload
    })

    expect(result.success).toBe(true)
  })
})

describe('email.send.requested topic names', () => {
  it('exposes main, retry, and DLQ topic constants', () => {
    expect(EMAIL_SEND_REQUESTED_TOPIC).toBe('email.send.requested')
    expect(EMAIL_SEND_REQUESTED_RETRY_TOPIC).toBe('email.send.requested.retry')
    expect(EMAIL_SEND_REQUESTED_DLQ_TOPIC).toBe('email.send.requested.dlq')
  })
})
```

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: FAIL — `text` isn't in the schema yet, so `'rejects a payload missing text'` fails (it
currently succeeds, because there's nothing to be missing).

- [ ] **Step 2: Add `text` to the schema**

Replace the full contents of `packages/event-schemas/src/email-send-requested.schema.ts`:

```ts
import { z } from 'zod'

export const EMAIL_SEND_REQUESTED_TOPIC = 'email.send.requested'
export const EMAIL_SEND_REQUESTED_RETRY_TOPIC = 'email.send.requested.retry'
export const EMAIL_SEND_REQUESTED_DLQ_TOPIC = 'email.send.requested.dlq'

export const EmailSendRequestedPayloadSchema = z.object({
  emailId: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  from: z.email(),
  fromName: z.string().min(1).optional(),
  to: z.email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  idempotencyKey: z.string().min(1).optional()
})

export type EmailSendRequestedPayload = z.infer<typeof EmailSendRequestedPayloadSchema>
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: PASS (8 tests).

- [ ] **Step 4: Write the failing SES sender test**

Replace the full contents of `apps/dispatch-worker/src/email/infra/ses/__tests__/ses-email-sender.unit.ts`:

```ts
import { type SendEmailCommand, type SESClient } from '@aws-sdk/client-ses'
import { describe, expect, it, vi } from 'vitest'

import { SesEmailSender } from '../ses-email-sender.ts'

function fakeSesClient(send: SESClient['send']): SESClient {
  return { send } as unknown as SESClient
}

describe('SesEmailSender', () => {
  it('sends the email and returns the SES message id', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'ses-msg-1' })
    const sender = new SesEmailSender(fakeSesClient(send))

    const result = await sender.send({
      from: 'a@ruguin.dev',
      to: 'b@ruguin.dev',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi'
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.sesMessageId).toBe('ses-msg-1')
    }

    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0]?.[0] as SendEmailCommand
    expect(command.input).toEqual({
      Source: 'a@ruguin.dev',
      Destination: { ToAddresses: ['b@ruguin.dev'] },
      Message: {
        Subject: { Data: 'Hi' },
        Body: { Html: { Data: '<p>Hi</p>' }, Text: { Data: 'Hi' } }
      }
    })
  })

  it('formats Source as "Name <email>" when fromName is provided', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'ses-msg-2' })
    const sender = new SesEmailSender(fakeSesClient(send))

    await sender.send({
      from: 'a@ruguin.dev',
      fromName: 'Will Gravina',
      to: 'b@ruguin.dev',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi'
    })

    const command = send.mock.calls[0]?.[0] as SendEmailCommand
    expect(command.input.Source).toBe('Will Gravina <a@ruguin.dev>')
  })

  it('returns a SesSendError when the SDK call rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Throttled'))
    const sender = new SesEmailSender(fakeSesClient(send))

    const result = await sender.send({
      from: 'a@ruguin.dev',
      to: 'b@ruguin.dev',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi'
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('SesSendError')
    }
  })

  it('returns a SesSendError instead of an empty sesMessageId when SES reports no MessageId', async () => {
    const send = vi.fn().mockResolvedValue({})
    const sender = new SesEmailSender(fakeSesClient(send))

    const result = await sender.send({
      from: 'a@ruguin.dev',
      to: 'b@ruguin.dev',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi'
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('SesSendError')
    }
  })
})
```

Run: `pnpm --filter @ruguin/dispatch-worker test -- ses-email-sender`
Expected: FAIL — `SendEmailInput` doesn't accept `text` yet, and `Body` is still `Html`-only.

- [ ] **Step 5: Update the port and the sender**

Replace the full contents of `apps/dispatch-worker/src/email/application/providers/email-sender.port.ts`:

```ts
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const EMAIL_SENDER_PROVIDER = Symbol('EMAIL_SENDER_PROVIDER')

export type SendEmailInput = Readonly<{
  from: string
  fromName?: string
  to: string
  subject: string
  html: string
  text: string
}>
export type SendEmailOutput = Readonly<{ sesMessageId: string }>

export interface EmailSenderPort {
  send(input: SendEmailInput): Promise<Either<BaseError, SendEmailOutput>>
}
```

In `apps/dispatch-worker/src/email/infra/ses/ses-email-sender.ts`, change the `SendEmailCommand`'s
`Body`:

```ts
      const response = await this.client.send(
        new SendEmailCommand({
          Source: input.fromName === undefined ? input.from : `${input.fromName} <${input.from}>`,
          Destination: { ToAddresses: [input.to] },
          Message: {
            Subject: { Data: input.subject },
            Body: { Html: { Data: input.html }, Text: { Data: input.text } }
          }
        })
      )
```

- [ ] **Step 6: Run the SES sender test to verify it passes**

Run: `pnpm --filter @ruguin/dispatch-worker test -- ses-email-sender`
Expected: PASS (4 tests).

- [ ] **Step 7: Thread `text` through the use case**

In `apps/dispatch-worker/src/email/application/use-cases/send-email.use-case.ts`, add `text` to
`SendEmailUseCaseInput`:

```ts
export type SendEmailUseCaseInput = Readonly<{
  emailId: string
  organizationId: string
  projectId: string
  from: string
  fromName?: string | undefined
  to: string
  subject: string
  html: string
  text: string
  /*
   * Zod-optional fields infer as `T | undefined`, not just optional — match that spelling for
   * exactOptionalPropertyTypes compatibility when consumers spread parsed payloads in directly.
   */
  idempotencyKey?: string | undefined
  attempt: number
}>
```

And in `processClaimedAttempt`, pass it through to the sender:

```ts
    const sent = await this.emailSender.send({
      from: input.from,
      ...(input.fromName !== undefined && { fromName: input.fromName }),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text
    })
```

In `apps/dispatch-worker/src/email/application/use-cases/__tests__/send-email.use-case.unit.ts`,
add `text` to the shared `BASE_INPUT` fixture (every test in the file spreads `...BASE_INPUT`, so
this one line is sufficient — no other line in that file needs to change):

```ts
const BASE_INPUT = {
  emailId: 'email-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  from: 'a@ruguin.dev',
  to: 'b@ruguin.dev',
  subject: 'Hi',
  html: '<p>Hi</p>',
  text: 'Hi',
  attempt: 0
}
```

- [ ] **Step 8: Run the dispatch-worker test suite and type check**

Run: `pnpm --filter @ruguin/dispatch-worker test && pnpm --filter @ruguin/dispatch-worker check:types`
Expected: PASS.

- [ ] **Step 9: Run the full monorepo type check for the touched packages**

Run: `pnpm --filter @ruguin/event-schemas check:types && pnpm --filter @ruguin/dispatch-worker check:types`
Expected: PASS. `apps/core-server`'s `check:types` remains expected-RED (Task 3's documented
breakage) — do not fix it here.

- [ ] **Step 10: Commit**

```bash
git add packages/event-schemas apps/dispatch-worker
git commit -m "feat: thread text through email.send.requested and the SES sender"
```

---

### Task 7: `SendEmailUseCase` (core-server) — wire the cache and `text` end to end

**Files:**

- Modify: `apps/core-server/src/modules/emails/application/use-cases/send-email.use-case.ts`
- Test: `apps/core-server/src/modules/emails/application/use-cases/__tests__/send-email.use-case.unit.ts` (modify)
- Test: `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.unit.ts` (modify)

**Interfaces:**

- Consumes: `TEMPLATE_CACHE_PROVIDER`/`TemplateCacheProvider` (Task 5), `renderTemplate`'s `text`
  field (Task 4), `Email.create`'s `text` field (Task 3), `EmailSendRequestedPayloadSchema`'s `text`
  field (Task 6).

- [ ] **Step 1: Update the failing use case test**

Replace the full contents of `apps/core-server/src/modules/emails/application/use-cases/__tests__/send-email.use-case.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type OutboxPort } from '../../../../../shared/domain/contracts/outbox.port'
import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type TransactionManager } from '../../../../../shared/domain/contracts/transaction-manager.contract'
import { EnqueueOutboxMessageError } from '../../../../../shared/domain/errors/enqueue-outbox-message.error'
import { type SenderIdentityCacheProvider } from '../../../../sender-identities/domain/contracts/sender-identity-cache.provider'
import { SenderIdentityNotVerifiedError } from '../../../../sender-identities/domain/errors/sender-identity-not-verified.error'
import { SenderIdentity } from '../../../../sender-identities/domain/models/sender-identity.model'
import { type TemplateCacheProvider } from '../../../../templates/domain/contracts/template-cache.provider'
import { TemplateNotFoundError } from '../../../../templates/domain/errors/template-not-found.error'
import { Template } from '../../../../templates/domain/models/template.model'
import { type EmailRepository } from '../../../domain/contracts/repositories/email.repository'
import { CreateEmailError } from '../../../domain/errors/models/create-email.error'
import { InvalidEmailPayloadError } from '../../../domain/errors/models/invalid-email-payload.error'
import { Email } from '../../../domain/models/email.model'
import { SendEmailUseCase } from '../send-email.use-case'

function validId(modelName: string): ID {
  const generated = ID.generate({ modelName })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity(overrides: Partial<{ verifiedAt: Date | null }> = {}) {
  const result = SenderIdentity.create({
    id: validId('SenderIdentity'),
    projectId: '01900000-0000-7000-8000-000000000001',
    name: 'Sender',
    email: 'sender@example.com',
    verifiedAt: overrides.verifiedAt === undefined ? new Date() : overrides.verifiedAt,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function buildTemplate(senderIdentityId: string) {
  const result = Template.create({
    id: validId('Template'),
    projectId: '01900000-0000-7000-8000-000000000001',
    senderIdentityId,
    name: 'Welcome',
    subject: 'Hi {{name}}',
    html: '<p>Hi {{name}}</p>',
    text: 'Hi {{name}}',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function buildEmail(overrides: Partial<{ idempotencyKey: string | null }> = {}) {
  const result = Email.create({
    id: validId('Email'),
    projectId: '01900000-0000-7000-8000-000000000001',
    templateId: '01900000-0000-7000-8000-000000000010',
    senderIdentityId: '01900000-0000-7000-8000-000000000011',
    idempotencyKey: overrides.idempotencyKey ?? null,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hi Ada',
    html: '<p>Hi Ada</p>',
    text: 'Hi Ada',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function createTransactionManagerStub(): TransactionManager {
  return {
    execute: async (work) => work({} as TransactionContext)
  }
}

describe('SendEmailUseCase', () => {
  it('renders the template, persists the email, and enqueues email.send.requested when the row is new', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const email = buildEmail()
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const templateCache: TemplateCacheProvider = { get: vi.fn().mockResolvedValue(success(template)), invalidate: vi.fn() }
    const senderIdentityCache: SenderIdentityCacheProvider = {
      get: vi.fn().mockResolvedValue(success(senderIdentity)),
      invalidate: vi.fn()
    }
    const enqueue = vi.fn().mockResolvedValue(success(undefined))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      templateCache,
      senderIdentityCache,
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: { name: 'Ada' }
    })

    expect(result.isSuccess()).toBe(true)
    // Proves the *rendered* output and the *resolved* sender — not some other field — got persisted.
    expect(createIfNotExists).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({
          templateId: template.id.toString(),
          senderIdentityId: senderIdentity.id.toString(),
          from: senderIdentity.email,
          to: 'recipient@example.com',
          subject: 'Hi Ada',
          html: '<p>Hi Ada</p>',
          text: 'Hi Ada'
        })
      })
    )
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [event, options] = enqueue.mock.calls[0] as [
      { name: string; payload: unknown },
      { topic: string; key: string }
    ]
    expect(options.topic).toBe('email.send.requested')
    expect(event.payload).toMatchObject({
      organizationId: '01900000-0000-7000-8000-000000000002',
      projectId: '01900000-0000-7000-8000-000000000001',
      from: senderIdentity.email,
      text: 'Hi Ada'
    })
  })

  it('does not enqueue a second event when the row already existed (idempotent replay)', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const email = buildEmail({ idempotencyKey: 'idem-1' })
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: false }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn()
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { get: vi.fn().mockResolvedValue(success(template)), invalidate: vi.fn() },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {},
      idempotencyKey: 'idem-1'
    })

    expect(result.isSuccess()).toBe(true)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('includes idempotencyKey in the enqueued payload when the row is new and one was supplied', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const email = buildEmail({ idempotencyKey: 'idem-1' })
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn().mockResolvedValue(success(undefined))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { get: vi.fn().mockResolvedValue(success(template)), invalidate: vi.fn() },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {},
      idempotencyKey: 'idem-1'
    })

    expect(result.isSuccess()).toBe(true)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [event] = enqueue.mock.calls[0] as [{ payload: unknown }]
    expect(event.payload).toMatchObject({ idempotencyKey: 'idem-1' })
  })

  it('fails with TemplateNotFoundError when the templateId does not resolve for this project', async () => {
    const templateCache: TemplateCacheProvider = { get: vi.fn().mockResolvedValue(success(null)), invalidate: vi.fn() }
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const senderIdentityCache: SenderIdentityCacheProvider = { get: vi.fn(), invalidate: vi.fn() }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      templateCache,
      senderIdentityCache,
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: 'missing-template',
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(TemplateNotFoundError)
    expect(createIfNotExists).not.toHaveBeenCalled()
    expect(senderIdentityCache.get).not.toHaveBeenCalled()
  })

  it('fails with MissingTemplateVariableError and never persists when a variable is missing', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const templateCache: TemplateCacheProvider = { get: vi.fn().mockResolvedValue(success(template)), invalidate: vi.fn() }
    const senderIdentityCache: SenderIdentityCacheProvider = {
      get: vi.fn().mockResolvedValue(success(senderIdentity)),
      invalidate: vi.fn()
    }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      templateCache,
      senderIdentityCache,
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    expect(createIfNotExists).not.toHaveBeenCalled()
  })

  it('fails with SenderIdentityNotVerifiedError and never persists when the sender identity is not verified', async () => {
    const senderIdentity = buildSenderIdentity({ verifiedAt: null })
    const template = buildTemplate(senderIdentity.id.toString())
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const templateCache: TemplateCacheProvider = { get: vi.fn().mockResolvedValue(success(template)), invalidate: vi.fn() }
    const senderIdentityCache: SenderIdentityCacheProvider = {
      get: vi.fn().mockResolvedValue(success(senderIdentity)),
      invalidate: vi.fn()
    }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      templateCache,
      senderIdentityCache,
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: { name: 'Ada' }
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(SenderIdentityNotVerifiedError)
    expect(createIfNotExists).not.toHaveBeenCalled()
  })

  it('propagates a repository failure without enqueueing', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const persistenceError = new CreateEmailError({ error: new Error('db down') })
    const createIfNotExists = vi.fn().mockResolvedValue(failure(persistenceError))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn()
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { get: vi.fn().mockResolvedValue(success(template)), invalidate: vi.fn() },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('fails with InvalidEmailPayloadError and never enqueues when the built payload fails schema validation', async () => {
    /*
     * "to" is the one field the caller still controls end-to-end — Email.create only checks it's
     * non-empty (not real email format), so this string clears the domain model but must still
     * trip the defensive safeParse backstop before any transaction opens.
     */
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn()
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { get: vi.fn().mockResolvedValue(success(template)), invalidate: vi.fn() },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'not-an-email',
      templateId: template.id.toString(),
      variables: { name: 'Ada' }
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(InvalidEmailPayloadError)
    expect(createIfNotExists).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rolls the transaction back to failure when the outbox enqueue fails on a newly created row', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const email = buildEmail()
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueueError = new EnqueueOutboxMessageError({ error: new Error('kafka unreachable') })
    const enqueue = vi.fn().mockResolvedValue(failure(enqueueError))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { get: vi.fn().mockResolvedValue(success(template)), invalidate: vi.fn() },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(enqueueError)
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- send-email.use-case`
Expected: FAIL — `SendEmailUseCase`'s constructor still takes `TemplateLookupProvider`, not
`TemplateCacheProvider`, and its render call/payload don't carry `text` yet.

- [ ] **Step 2: Update the use case**

Replace the full contents of `apps/core-server/src/modules/emails/application/use-cases/send-email.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { EMAIL_SEND_REQUESTED_TOPIC, EmailSendRequestedPayloadSchema } from '@ruguin/event-schemas'
import { type BaseError, Event, ID, type JsonValue } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { OUTBOX_PORT, type OutboxPort } from '../../../../shared/domain/contracts/outbox.port'
import {
  TRANSACTION_MANAGER,
  type TransactionManager
} from '../../../../shared/domain/contracts/transaction-manager.contract'
import {
  SENDER_IDENTITY_CACHE_PROVIDER,
  type SenderIdentityCacheProvider
} from '../../../sender-identities/domain/contracts/sender-identity-cache.provider'
import { SenderIdentityNotVerifiedError } from '../../../sender-identities/domain/errors/sender-identity-not-verified.error'
import { TEMPLATE_CACHE_PROVIDER, type TemplateCacheProvider } from '../../../templates/domain/contracts/template-cache.provider'
import { TemplateNotFoundError } from '../../../templates/domain/errors/template-not-found.error'
import { renderTemplate } from '../../../templates/domain/render-template'
import { EMAIL_REPOSITORY, type EmailRepository } from '../../domain/contracts/repositories/email.repository'
import { InvalidEmailPayloadError } from '../../domain/errors/models/invalid-email-payload.error'
import { Email } from '../../domain/models/email.model'

export type SendEmailUseCaseInput = Readonly<{
  projectId: string
  organizationId: string
  to: string
  templateId: string
  variables: Record<string, string>
  idempotencyKey?: string
}>

@Injectable()
export class SendEmailUseCase {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly transactionManager: TransactionManager,
    @Inject(EMAIL_REPOSITORY) private readonly emailRepository: EmailRepository,
    @Inject(TEMPLATE_CACHE_PROVIDER) private readonly templateCache: TemplateCacheProvider,
    @Inject(SENDER_IDENTITY_CACHE_PROVIDER) private readonly senderIdentityCache: SenderIdentityCacheProvider,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort
  ) {}

  public async execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, Email>> {
    /*
     * Resolved from the cache-backed contract, not the raw lookup — the send path is the hot path
     * this cache exists for (design spec decision 6 of the React Email plan).
     */
    const templateResult = await this.templateCache.get({ templateId: input.templateId, projectId: input.projectId })
    if (templateResult.isFailure()) return failure(templateResult.value)
    if (templateResult.value === null) {
      return failure(new TemplateNotFoundError({ templateId: input.templateId }))
    }
    const template = templateResult.value

    /*
     * Resolved from the cache-backed contract, not the raw repository — the send path is the hot
     * path this cache exists for (design spec decision 5 of the SenderIdentity plan). A miss
     * (deleted row, cache/DB disagreement) is treated exactly like "not verified": there is no
     * legitimate send without a resolvable, verified sender.
     */
    const senderIdentityResult = await this.senderIdentityCache.get({ senderIdentityId: template.senderIdentityId })
    if (senderIdentityResult.isFailure()) return failure(senderIdentityResult.value)
    const senderIdentity = senderIdentityResult.value
    if (senderIdentity?.projectId !== input.projectId || !senderIdentity.isVerified()) {
      return failure(new SenderIdentityNotVerifiedError({ senderIdentityId: template.senderIdentityId }))
    }

    const rendered = renderTemplate({
      subject: template.subject,
      html: template.html,
      text: template.text,
      variables: input.variables
    })
    if (rendered.isFailure()) return failure(rendered.value)

    const idGenerated = ID.generate({ modelName: 'Email' })
    if (idGenerated.isFailure()) {
      /*
       * Same posture as Event.create(): UUID generation itself failing is treated as a bug, not
       * an expected domain failure — there is no meaningful recovery for the caller here.
       */
      throw new Error(`Failed to generate an id for a new email: ${idGenerated.value.message}`)
    }

    const emailResult = Email.create({
      id: idGenerated.value.idGenerated,
      projectId: input.projectId,
      templateId: input.templateId,
      senderIdentityId: senderIdentity.id.toString(),
      idempotencyKey: input.idempotencyKey ?? null,
      from: senderIdentity.email,
      to: input.to,
      subject: rendered.value.subject,
      html: rendered.value.html,
      text: rendered.value.text,
      createdAt: new Date()
    })
    if (emailResult.isFailure()) return emailResult

    /*
     * Validated up front, from the not-yet-persisted email, so a malformed payload never opens a
     * DB transaction. safeParse (never .parse()) keeps this an Either failure, matching the
     * method's own contract, instead of a throw that would otherwise surface as a generic 500.
     */
    const payloadParsed = EmailSendRequestedPayloadSchema.safeParse({
      emailId: emailResult.value.id.toString(),
      organizationId: input.organizationId,
      projectId: emailResult.value.projectId,
      from: emailResult.value.from,
      fromName: senderIdentity.name,
      to: emailResult.value.to,
      subject: emailResult.value.subject,
      html: emailResult.value.html,
      text: emailResult.value.text,
      ...(emailResult.value.idempotencyKey !== null && { idempotencyKey: emailResult.value.idempotencyKey })
    })
    if (!payloadParsed.success) return failure(new InvalidEmailPayloadError({ error: payloadParsed.error }))

    /*
     * z.infer makes `idempotencyKey` `string | undefined` (Zod's `.optional()` convention), which
     * JsonValue's index signature rejects even though Zod never emits the key holding `undefined`
     * — it's simply absent when not supplied. The cast bridges that TypeScript-only mismatch;
     * safeParse above already did the real runtime validation.
     */
    const payload = payloadParsed.data as JsonValue

    return this.transactionManager.execute(async (tx) => {
      const persistResult = await this.emailRepository.createIfNotExists({ email: emailResult.value, tx })
      if (persistResult.isFailure()) return failure(persistResult.value)

      const { email: persisted, created } = persistResult.value

      if (created) {
        const event = Event.create(EMAIL_SEND_REQUESTED_TOPIC, payload)
        const enqueued = await this.outbox.enqueue(
          event,
          { topic: EMAIL_SEND_REQUESTED_TOPIC, key: persisted.projectId },
          tx
        )
        if (enqueued.isFailure()) return failure(enqueued.value)
      }

      return success(persisted)
    })
  }
}
```

The only structural change from before: the first lookup now goes through `TemplateCacheProvider`
(unwrapped `Template | null`, not `{ template: Template | null }` — `TemplateLookupProvider`'s
return shape) and both the render call and the persisted `Email`/payload carry `text`.

- [ ] **Step 3: Run the use case test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- send-email.use-case`
Expected: PASS (10 tests).

- [ ] **Step 4: Update the controller unit test's `Email` fixture**

In `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.unit.ts`,
the `buildEmail()` helper needs `text` added. Find:

```ts
function buildEmail() {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: 'template-1',
    senderIdentityId: 'sender-1',
    idempotencyKey: null,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hi',
    html: '<p>Hi</p>',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}
```

Replace with:

```ts
function buildEmail() {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: 'template-1',
    senderIdentityId: 'sender-1',
    idempotencyKey: null,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hi',
    html: '<p>Hi</p>',
    text: 'Hi',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}
```

No other line in that file references `Email.create`'s input directly — this is the only fixture
needing the update.

- [ ] **Step 5: Update `emails.module.ts` — no changes needed, confirm**

`SendEmailUseCase`'s constructor now injects `TEMPLATE_CACHE_PROVIDER` instead of
`TEMPLATE_LOOKUP_PROVIDER` — both are exported by `TemplatesModule` (Task 5, Step 8), and
`emails.module.ts` already imports `TemplatesModule` in full (not a specific provider), so no edit
is needed here. Confirm by reading `apps/core-server/src/modules/emails/emails.module.ts` and
checking it still compiles clean in the next step — if it doesn't, the DI wiring assumption above is
wrong and needs fixing before proceeding.

- [ ] **Step 6: Run the full core-server test suite, type check, and lint**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: unit tests PASS, `check:types` clean (the breakage documented since Task 3 is fully
resolved now — confirm no errors remain anywhere in the package). e2e is expected to still fail —
Task 8 rewrites the relevant assertion.

- [ ] **Step 7: Commit**

```bash
git add apps/core-server
git commit -m "feat(core-server): resolve template via TemplateCacheProvider, thread text through send"
```

---

### Task 8: e2e verification

**Files:**

- Test: `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.e2e.ts` (modify)

**Interfaces:**

- Consumes: everything from Tasks 1–7. This is the final integration point for this plan — every
  piece gets exercised together for the first time here.

- [ ] **Step 1: Extend the rendered-content assertion**

In `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.e2e.ts`,
find the test `'accepts a templateId + variables request, persists the rendered content, and returns
202'`. Its final block reads:

```ts
    /*
     * The seeded template (prisma/seed.ts) is subject 'Hi {{name}}' / html '<p>Hi {{name}}</p>' —
     * asserting the persisted row, not just the 202, is what actually proves rendering happened.
     */
    const prisma = app.get(PrismaService)
    const row = await prisma.email.findUnique({ where: { id: body.id } })
    expect(row?.subject).toBe('Hi Ada')
    expect(row?.html).toBe('<p>Hi Ada</p>')
  })
```

Replace it with:

```ts
    /*
     * The seeded template (prisma/seed.ts) now comes from packages/email-templates's
     * WelcomeEmail component — subject 'Hi {{name}}', html/text both containing '{{name}}' —
     * asserting the persisted row, not just the 202, is what actually proves rendering happened.
     * html/text are checked for the substituted name rather than an exact string match: the
     * React Email component's markup (Step 7, Task 1 of this plan) is an implementation detail
     * this test should not need to know byte-for-byte.
     */
    const prisma = app.get(PrismaService)
    const row = await prisma.email.findUnique({ where: { id: body.id } })
    expect(row?.subject).toBe('Hi Ada')
    expect(row?.html).toContain('Ada')
    expect(row?.html).not.toContain('{{name}}')
    expect(row?.text).toContain('Ada')
    expect(row?.text).not.toContain('{{name}}')
  })
```

- [ ] **Step 2: Rebuild `@ruguin/email-templates`, then run the full e2e suite**

Run: `pnpm --filter @ruguin/email-templates build` (Global Constraints — the seed this suite runs
against consumes the built output).
Then: `pnpm --filter @ruguin/core-server test:e2e`
Expected: PASS, with a completely empty shell environment (no `.env`, no `pnpm with-env`) —
`vitest.setup.e2e.ts` alone must be sufficient, matching the standard already established in the
prior plan.

- [ ] **Step 3: Run the full core-server suite, type check, and lint one more time**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server test:integration && pnpm --filter @ruguin/core-server test:e2e && pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: everything PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/core-server
git commit -m "test(core-server): assert persisted text and substituted html/text in the send e2e"
```

---

## Final verification

After Task 8, run the full monorepo suite once, from the repo root, with a completely empty shell
environment (matching how `.husky/pre-push` actually invokes it):

```bash
pnpm check:spelling
env -i PATH="$PATH" HOME="$HOME" pnpm test
```

Expected: PASS across every package (`turbo run test:all`), plus a clean `check:spelling` — a prior
plan's final review found a Critical failure there (`sesv` from `@aws-sdk/client-sesv2`) that no
per-task review had caught, because no per-task review runs the repo-wide spelling gate. If this
plan's new words (`tsdown` already recognized; check `react`, `jsx`, `Preview`, `dev`) trip
`check:spelling`, add them to `.cspell.json`'s `words` array in alphabetical order, following the
exact precedent of the `sesv` entry already there.
