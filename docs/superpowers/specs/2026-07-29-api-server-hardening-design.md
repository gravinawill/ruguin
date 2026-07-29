# API Server Hardening — Design

**Data:** 2026-07-29
**Escopo:** `apps/api-server` (NestJS)

## Contexto

`apps/api-server` é hoje o scaffold cru gerado por `nest new` — nunca foi integrado às convenções do monorepo (é um diretório não versionado, com um `.git` próprio dentro dele). Ele já tem `"type": "module"` no `package.json` e herda `@ruguin/typescript-config/nestjs.json` (que já assume `module: ESNext` + `moduleResolution: Bundler`), mas os scripts de teste ainda apontam para Jest, e um `vitest.config.ts` já foi criado seguindo o padrão do resto do monorepo (`packages/utils`, `packages/message-broker`) sem nunca ter sido ligado aos scripts.

Nenhum app ou package do monorepo usa hoje SWC, Pino, `@nestjs/terminus` ou OpenTelemetry — este design é o primeiro caso de uso de cada um deles no repo. Já existe, porém, um OTel Collector planejado/rodando localmente via Docker Compose (`infrastructure/local/`) esperando receber dados via OTLP em `localhost:4317` (gRPC) / `4318` (HTTP), e um k6 de smoke test (`infrastructure/local/k6/smoke.ts`) mirando o LocalStack como placeholder até o api-server ter rotas reais.

## Objetivo

Colocar o `apps/api-server` em conformidade com as convenções do monorepo (ESM real, Vitest, `@ruguin/eslint-config`/`typescript-config`/`prettier-config` como workspace deps) e adicionar a base de observabilidade/operação esperada de um serviço em produção: build via SWC, logger estruturado (Pino), tracing (OpenTelemetry) e health check (Terminus). Também documentar, no `CLAUDE.md` do projeto, a convenção de usar `@ruguin/utils` para tratamento de falhas esperadas.

## Fora de escopo

- Módulos de domínio/negócio (o app continua sendo só scaffold + fundação técnica).
- Health checks de dependências externas (Postgres/Redis/Kafka) no Terminus — entram quando esses clients existirem no app.
- Métricas e logs via OTel (só traces, via auto-instrumentation).
- Alterar o OTel Collector ou a infraestrutura de observabilidade já planejada/implementada em `infrastructure/local/`.

## 1. Limpeza prévia

`apps/api-server/.git` é um resíduo do `nest new` e precisa ser removido antes do diretório ser versionado no monorepo. O `package.json` do app hoje declara `eslint`, `@eslint/js`, `typescript-eslint`, `globals` como devDependencies próprias, apesar do `eslint.config.ts` já importar de `@ruguin/eslint-config` — que **não** está declarado como dependência. Isso é corrigido: remove as deps soltas duplicadas e adiciona `@ruguin/eslint-config`, `@ruguin/typescript-config`, `@ruguin/prettier-config` como `workspace:*`, replicando a convenção usada em `packages/utils`.

## 2. ESM real

O app mantém `"type": "module"`. Todos os imports relativos em `src/` passam a terminar em `.js` (ex.: `from './app.module.js'`) — isso é obrigatório para o Node resolver ESM em runtime puro (`node dist/main.js`), independente do `moduleResolution: Bundler` usado só para type-checking em tempo de desenvolvimento. `nest-cli.json` ganha `sourceRoot: "src"` e o builder SWC (seção 3) configurado para emitir ESM.

## 3. SWC (build + Vitest)

- `nest-cli.json`: `compilerOptions.builder: "swc"`, `compilerOptions.typeCheck: true` (mantém checagem de tipos via `tsc --noEmit` em paralelo, já que SWC não faz type-check).
- Novo `.swcrc` na raiz do `api-server` com `module.type: "es6"` (output ESM) e, criticamente, `jsc.transform.legacyDecorator: true` + `jsc.transform.decoratorMetadata: true` — sem isso a injeção de dependência do Nest quebra silenciosamente, pois o SWC precisa emitir os metadados de decorator que o `tsc` gera por padrão via `emitDecoratorMetadata`.
- `unplugin-swc` adicionado ao `vitest.config.ts` (mesma config de decorators do `.swcrc`), para que testes que instanciam classes com `@Injectable`/DI do Nest funcionem de forma idêntica ao runtime.
- Novas devDependencies: `@swc/core`, `@swc/cli`, `unplugin-swc`.

## 4. Vitest em camadas (unit / integration / e2e) + k6

`vitest.config.ts` passa a definir 3 projects:

| Project | Include | Timeout | Observação |
|---|---|---|---|
| unit | `src/**/*.unit.ts` | 5s | Mantém o padrão já usado em `packages/utils` |
| integration | `src/**/*.integration.ts` | 15s | Setup conecta em Postgres/Redis/Kafka reais via `infrastructure/local/docker-compose.yml` (env vars) |
| e2e | `src/**/*.e2e.ts` | 30s | Sobe a aplicação Nest completa via `Test.createTestingModule` + `supertest` |

Scripts do `package.json`: `test` (unit), `test:integration`, `test:e2e`, `test:all` (todos os projects), `test:cov`. Remove `jest`, `ts-jest`, `ts-loader`, `ts-node`, `@types/jest` das devDependencies e o bloco de configuração do Jest.

Testes de integration/e2e assumem que o stack local (`infrastructure/local/docker-compose.yml`) já está no ar — não sobem containers próprios.

Novo `infrastructure/local/k6/api-server-health.ts`, seguindo exatamente a estrutura do `smoke.ts` já existente (mesmo padrão de `Options`, `check`, `sleep`), com `K6_TARGET_URL` tendo como default a rota `/health` do Terminus (seção 7) do api-server.

## 5. Pino (via `nestjs-pino`)

`AppModule` importa `LoggerModule.forRootAsync` (pacote `nestjs-pino`) configurando `pino-http`: nível via `LOG_LEVEL` (default `info`), `pino-pretty` como transport somente fora de produção, e redact de headers sensíveis (`req.headers.authorization`). `main.ts` passa a chamar `NestFactory.create(AppModule, { bufferLogs: true })` e, logo em seguida, `app.useLogger(app.get(Logger))` para que o logger padrão do Nest seja substituído desde o boot.

Novas dependencies: `nestjs-pino`, `pino-http`. Nova devDependency: `pino-pretty`.

## 6. OpenTelemetry (auto-instrumentation)

Novo arquivo `src/tracing.ts`, carregado **antes** de qualquer outro import da aplicação via `node --import ./dist/tracing.js dist/main.js` — necessário em ESM para que o auto-instrumentation consiga interceptar (patch) os módulos antes deles serem carregados pelo resto da app. Usa `NodeSDK` (`@opentelemetry/sdk-node`) com `getNodeAutoInstrumentations()` (`@opentelemetry/auto-instrumentations-node`) e `OTLPTraceExporter` (`@opentelemetry/exporter-trace-otlp-http`) apontando para o Collector local — default `http://localhost:4318/v1/traces`, configurável via `OTEL_EXPORTER_OTLP_ENDPOINT`. Respeita a env var padrão `OTEL_SDK_DISABLED` (convenção oficial do SDK) para permitir desligar em dev sem precisar de flag própria.

Novas dependencies: `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`.

## 7. Terminus (health check básico)

Novo módulo `src/health/` (`health.module.ts` + `health.controller.ts`) expondo `GET /health` via `@HealthCheck()` do `@nestjs/terminus`, hoje com um array vazio de indicators — confirma apenas que o processo HTTP está de pé e respondendo. Checks de Postgres/Redis/Kafka são adicionados depois, quando esses clients existirem de fato no app (fora de escopo aqui).

Nova dependency: `@nestjs/terminus`.

## 8. `@ruguin/utils` + convenção no CLAUDE.md

`@ruguin/utils` é declarado como `workspace:*` no `package.json` do `api-server`. Não é forçado um uso artificial agora (o app ainda não tem lógica de domínio) — a integração real acontece quando features com falhas esperadas forem implementadas.

O `CLAUDE.md` da raiz do projeto ganha uma seção nova **"Code Conventions"**:

> Prefer `Either`/`Success`/`Failure` from `@ruguin/utils` for expected/domain failures instead of throwing exceptions or inventing ad-hoc result types. Check `@ruguin/utils` before adding a new dependency for common functional/utility helpers.

## Resumo de dependências

**dependencies (novas):** `@nestjs/terminus`, `nestjs-pino`, `pino-http`, `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@ruguin/utils` (workspace).

**devDependencies (novas):** `@swc/core`, `@swc/cli`, `unplugin-swc`, `pino-pretty`, `@ruguin/eslint-config`, `@ruguin/typescript-config`, `@ruguin/prettier-config` (workspace).

**devDependencies (removidas):** `jest`, `ts-jest`, `ts-loader`, `ts-node`, `@types/jest`, `eslint`, `@eslint/js`, `typescript-eslint`, `globals` (duplicadas — passam a vir só via `@ruguin/eslint-config`).

## Riscos / pontos de atenção para a implementação

- **Decorator metadata via SWC**: se `legacyDecorator`/`decoratorMetadata` não forem configurados corretamente no `.swcrc` (e replicados no `unplugin-swc`), a injeção de dependência do Nest falha silenciosamente em runtime e em testes.
- **Extensões `.js` em imports relativos**: fácil esquecer algum import ao migrar para ESM real; quebra em runtime (`ERR_MODULE_NOT_FOUND`), não em type-check.
- **Ordem de carregamento do OTel**: `tracing.ts` precisa ser carregado antes de qualquer outro módulo (via `--import`), senão a auto-instrumentation não intercepta os módulos a tempo.
- **Testes de integration/e2e dependem do stack local rodando** (`infrastructure/local/docker-compose.yml`) — precisa estar documentado (README do api-server ou do próprio `infrastructure/local`) que esses testes falham se o stack não estiver de pé, inclusive para uma futura configuração de CI.
