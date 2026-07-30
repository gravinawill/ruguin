# Core Server — Documentação de API (Scalar) + Harden do bootstrap — Design

**Data:** 2026-07-30
**Escopo:** `apps/core-server` (NestJS + Fastify)

## Contexto

`apps/core-server` (renomeado de `apps/api-server`) hoje só expõe `GET /health` (Terminus), sem nenhuma documentação de API, sem versionamento de rotas e sem os middlewares de hardening HTTP comuns (headers de segurança, compressão). Não existe nenhuma infraestrutura de autenticação em nenhum lugar do monorepo ainda.

O app usa o adapter Fastify nativamente (`@nestjs/platform-fastify`), não Express — isso restringe as opções de middleware a plugins Fastify-nativos (`@fastify/*`) em vez dos pacotes genéricos do ecossistema Express (`helmet`, `compression`, `morgan`).

## Objetivo

Adicionar documentação de API interativa (Scalar, a partir de um documento OpenAPI gerado pelo `@nestjs/swagger`) protegida por Basic Auth, e um pequeno pacote de hardening de bootstrap: headers de segurança, compressão de resposta, e versionamento de rotas via URI — mantendo `/health` fora do esquema de versão.

## Fora de escopo

- **i18n** (`nestjs-cls` + interceptor de idioma) — subsistema maior, próprio spec futuro. Se implementado a partir de um exemplo copiado de um projeto Express, os tipos de request precisam ser trocados para os do Fastify (`FastifyRequest`, não `Request` de `'express'`).
- **Métricas OpenTelemetry** (`OTLPMetricExporter`) — hoje só há export de traces (`create-tracing-sdk.ts`); adicionar métricas é um spec futuro separado.
- Decorar `HealthController` (ou qualquer controller existente) com `@ApiTags`/`@ApiOperation`/`@ApiResponse` — a infraestrutura de documentação é montada agora; decorar endpoints de negócio fica para quando eles existirem.
- Autenticação de negócio (JWT, sessions, etc.) — o Basic Auth aqui protege apenas as rotas de documentação, não é um mecanismo de auth de aplicação.

## 1. Documentação de API (Scalar)

Novo módulo `apps/core-server/src/bootstrap/configure-app.ts`, exportando `configureApp(app: NestFastifyApplication): Promise<void>` — toda a configuração de bootstrap descrita neste spec vive aqui, não direto em `main.ts`, para ser testável via `Test.createTestingModule` + `supertest` (mesmo motivo que levou a extrair `resolveOtlpEndpoint` de `tracing.ts` para `create-tracing-sdk.ts`: lógica de configuração sem side-effect de processo, separada do entrypoint).

Dentro de `configureApp`:

```ts
const config = new DocumentBuilder()
  .setTitle('Core Server API')
  .setDescription('API interna do core-server — health check e endpoints de negócio futuros.')
  .setVersion('0.0.1')
  .build()
const document = SwaggerModule.createDocument(app, config)

app.use('/docs', apiReference({ withFastify: true, content: document }))
app.getHttpAdapter().get('/docs-json', (_req, reply) => reply.send(document))
```

- `/docs`: UI interativa do Scalar, renderizada a partir do documento em memória (sem passar por `SwaggerModule.setup`, que montaria a UI padrão do Nest em cima da mesma rota).
- `/docs-json`: documento OpenAPI cru, para importar em Postman/gerar clients.
- Nenhum controller existente ganha decorators novos — o Nest já infere rota/método/DTOs básicos sem eles.

**Novas dependencies:** `@nestjs/swagger`, `@scalar/nestjs-api-reference`.

## 2. Basic Auth para `/docs` e `/docs-json`

Sem infraestrutura de auth hoje no monorepo — a proteção usa `@fastify/basic-auth`, o plugin oficial do ecossistema Fastify (o app já usa Fastify nativamente, não faz sentido introduzir uma lib Express-first ou um `Guard` do zero para um caso tão simples).

Em `configureApp`, antes de montar `/docs`:

```ts
const fastify = app.getHttpAdapter().getInstance()

await app.register(fastifyBasicAuth, {
  validate: async (username, password) => {
    if (username === docsENV.DOCS_USERNAME && password === docsENV.DOCS_PASSWORD) return
    throw new Error('Invalid credentials')
  },
  authenticate: true
})

fastify.addHook('onRequest', (request, reply, done) => {
  if (!request.url.startsWith('/docs')) return done()
  fastify.basicAuth(request, reply, done)
})
```

O hook `onRequest` é global mas condicional por prefixo de path — só exige credenciais quando a URL começa com `/docs` (cobre `/docs` e `/docs-json` de uma vez), deixando `/health` e qualquer rota de negócio futura sem essa exigência.

Credenciais via novo `packages/env/src/packages/docs.environment.ts`, seguindo exatamente o padrão de `logger.environment.ts`:

```ts
export const docsENV = createEnv({
  server: {
    DOCS_USERNAME: z.string().min(1),
    DOCS_PASSWORD: z.string().min(1)
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true
})
```

Obrigatórias em **todo** ambiente (local, test, staging, production) — sem fallback de dev. O boot falha imediatamente se ausentes, em vez de a aplicação subir com `/docs` mal protegido. Exportado a partir de `packages/env/src/packages/index.ts` junto dos demais.

**Nova dependency:** `@fastify/basic-auth`.

## 3. Harden do bootstrap (headers + compressão)

Ainda em `configureApp`, registrados como plugins Fastify (não middleware Express):

```ts
await app.register(helmet)
await app.register(compress)
```

`morgan` (pedido inicialmente) fica de fora: é middleware Express e não roda nativo em Fastify sem um shim (`@fastify/middie`); o log estruturado de requests já é coberto pelo `nestjs-pino`/`pino-http` (`createPinoHttpOptions`), já integrado ao stack de observability (Loki/Grafana) validado anteriormente. Adicioná-lo seria redundante.

**Novas dependencies:** `@fastify/helmet`, `@fastify/compress`.

## 4. Versionamento de rotas (URI)

```ts
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
```

`defaultVersion: '1'` garante que qualquer controller futuro sem `version` explícito resolve em `/v1/...` em vez de retornar 404 (comportamento padrão do Nest quando versionamento está ligado mas a rota não declara versão).

`HealthController` é atualizado para ficar fora do esquema de versão — health check é consumido por infra (orquestrador, Terminus), não por clientes de API versionados:

```ts
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController { ... }
```

Nenhuma dependency nova (`VersioningType`/`VERSION_NEUTRAL` já vêm de `@nestjs/common`, já presente).

## 5. `main.ts`

`bootstrap()` passa a chamar `await configureApp(app)` logo após criar a app e antes de `app.listen(...)`:

```ts
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { bufferLogs: true })
app.enableShutdownHooks()
app.useLogger(app.get(Logger))
await configureApp(app)
await app.listen(process.env.PORT ?? 3000, '0.0.0.0')
```

## 6. Testes

- `health.controller.e2e.ts` (existente) não muda — só importa `AppModule`, nunca `main.ts`/`configureApp`, então não é afetado pela nova exigência de `DOCS_USERNAME`/`DOCS_PASSWORD`. Precisa continuar passando com `/health` respondendo 200 sem prefixo de versão (confirma que `VERSION_NEUTRAL` funcionou).
- Novo `configure-app.e2e.ts`: sobe a app completa via `Test.createTestingModule` + `NestFastifyApplication`, chama `configureApp(app)` manualmente (setando `DOCS_USERNAME`/`DOCS_PASSWORD` no ambiente do teste), e cobre:
  - `GET /docs` sem credenciais → 401
  - `GET /docs` com credenciais corretas (`Authorization: Basic ...`) → 200
  - `GET /docs-json` sem credenciais → 401; com credenciais → 200, corpo com campo `openapi`
  - `GET /health` → 200, sem prefixo `/v1`

## Resumo de dependências

**dependencies (novas):** `@nestjs/swagger`, `@scalar/nestjs-api-reference`, `@fastify/basic-auth`, `@fastify/helmet`, `@fastify/compress`.

**devDependencies:** nenhuma nova.

**`packages/env`:** novo `docsENV` (`DOCS_USERNAME`, `DOCS_PASSWORD`), barrel-exportado junto dos demais schemas em `packages/env/src/packages/index.ts`.

## Riscos / pontos de atenção para a implementação

- **`configureApp` precisa ser chamado antes de `app.listen(...)`**, mas depois de `app.useLogger(...)` — a ordem importa para que erros de configuração (ex.: `docsENV` faltando) apareçam já formatados pelo logger estruturado.
- **Hook `onRequest` por prefixo de path**: se o prefixo checado (`/docs`) não cobrir exatamente as duas rotas (`/docs`, `/docs-json`), uma delas fica exposta sem auth por engano — testar as duas explicitamente no e2e novo, não só uma.
- **`defaultVersion: '1'` é retroativo para qualquer controller futuro sem versão declarada** — se algum controller de infraestrutura futuro (análogo ao health check) também precisar ficar fora do versionamento, precisa de `VERSION_NEUTRAL` explícito, do contrário cai em `/v1/...` por default.
- **`docsENV` obrigatório em todo ambiente**: quem for rodar `core-server` localmente pela primeira vez após esta mudança precisa setar `DOCS_USERNAME`/`DOCS_PASSWORD` no `.env` local, ou o boot falha. Vale atualizar o README/`.env.example` do app.
