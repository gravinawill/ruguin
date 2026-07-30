# Core Server — Arquitetura (DDD + Hexagonal) — Design

**Data:** 2026-07-29
**Escopo:** `apps/core-server` (renomeado de `apps/api-server`), `packages/ddd-kernel` (novo)

## Contexto

`apps/api-server` hoje é só a fundação técnica descrita em `docs/superpowers/specs/2026-07-29-api-server-hardening-design.md` (NestJS + SWC + Vitest em camadas + Pino + OpenTelemetry + Terminus), sem nenhum módulo de domínio — só `health/`. Segundo `docs/product-spec.md`, esse app corresponde ao que o spec de produto chama de **API Service**: dono exclusivo do schema Postgres de organizações, projetos, API keys, templates, domínios verificados e emails; expõe `POST /emails` + CRUD de conta (seção 3.2 e 3.8); publica o evento `email.send.requested` (seção 5); e precisa de isolamento multi-tenant e idempotência garantida por constraint de banco (seção 3.1, 3.2, NFR 4.2).

Este design renomeia `api-server` para `core-server` (nome mais alinhado ao papel real do serviço) e define a arquitetura de domínio por cima da fundação técnica já existente: camadas com inversão de dependência, DDD com `Either` em vez de exceptions para falhas esperadas, transação de banco controlada a nível de use case, e padrão outbox para publicar eventos Kafka de forma atômica com a escrita no Postgres.

## Objetivo

Estabelecer a arquitetura modular do `core-server` — estrutura de pastas, regras de dependência entre camadas, kernel DDD compartilhado (`packages/ddd-kernel`), padrão de repositório com inversão de dependência, mecanismo de transação/outbox, e convenção de testes — de forma que features de domínio (organizations, projects, api-keys, templates, domains, emails) possam ser implementadas de forma consistente e testável.

## Fora de escopo

- Implementação das features de domínio em si (isso é o próximo passo, via plano de implementação).
- Dispatch Worker, SES Webhook Ingestor, Tracking Service, Webhook Notifier, Read-Model Updater — outros serviços do product-spec, fora do `core-server`.
- Autenticação por API key (cache Redis, hashing) — reaproveita esta arquitetura quando for implementada, não é detalhada aqui.
- Ferramenta de enforcement automático das regras de dependência entre camadas (ex.: ESLint boundaries) — regra é por convenção/revisão de código neste momento.
- Verificação de domínio (SPF/DKIM/DMARC) — decisão em aberto no product-spec.

## 1. Rename `api-server` → `core-server`

1. `git mv apps/api-server apps/core-server`.
2. `apps/core-server/package.json`: `name` `@ruguin/api-server` → `@ruguin/core-server`.
3. Atualizar referências ao nome/diretório `api-server` em: `infrastructure/local/docker-compose*.yml` (nome do serviço, se houver), `infrastructure/local/k6/api-server-health.ts` (mantém o arquivo, referência ao serviço no comentário/README se existir), script raiz `infra:load-test:api-server` em `package.json`, e a nota de implementação em `docs/product-spec.md` (linha ~35, que hoje diz "o código real em `apps/api-server` usa NestJS...").
4. O Postgres local (`infrastructure/local/docker-compose.yml`) hoje expõe um único database `ruguin` (usuário/senha `ruguin`). O `core-server` usa um **schema Postgres dedicado** (`core_server`) dentro desse mesmo database — não um database próprio — via `?schema=core_server` na `DATASOURCE_URL` do Prisma. Isso satisfaz literalmente a NFR 4.2 do product-spec ("cada serviço é dono exclusivo do seu **schema** Postgres") sem exigir provisionar um novo database na infra local.
5. `health/`, `logger/`, `tracing/`, `main.ts`, `app.module.ts`, `vitest.config.ts` são mantidos como estão nesta etapa (a mudança de convenção de testes descrita na seção 6 é aplicada junto, já que exige mover os arquivos de teste existentes).

## 2. Estrutura de pastas e regras de dependência

```
apps/core-server/
  src/
    <bounded-context>/                  # organization, project, api-key, template, domain, email
      domain/
        models/                         # entidades de domínio — NÃO são as tabelas Prisma
        value-objects/                  # VOs específicos do contexto
        errors/                         # erros de domínio deste contexto (extends BaseError)
      application/
        use-cases/                      # 1 arquivo por use case
        repositories/                   # interfaces (ports)
        providers/                      # interfaces (ports), ex.: id-generator
      infra/
        database/prisma/                # implementações concretas dos repositórios (adapters)
      presentation/
        <context>.controller.ts
        <context>.service.ts
        dto/
      <context>.module.ts               # bind interface -> implementação via DI
      __tests__/
        *.unit.ts
        *.int.ts
        *.e2e.ts
    shared/
      database/                         # PrismaService, TransactionManager, RollbackSignal
      outbox/                           # OutboxRepository (interface + Prisma), OutboxRelayService
      events/                           # adapter que fala com packages/message-broker
    health/ logger/ tracing/            # já existentes, mantidos
    main.ts app.module.ts               # já existentes, mantidos
  prisma/
    schema.prisma                       # schema único — este é o único serviço dono deste banco
```

### Regra de dependência entre camadas

```
Controller → Service → Use Case → { Repository (interface) | Provider (interface) | Model | Value Object }
```

- **Controller**: só chama `Service`. Não conhece use case, Prisma ou domínio.
- **Service**: só chama Use Case(s). Não acessa repositório diretamente, não contém lógica de negócio.
- **Use Case**: contém a lógica de negócio. Chama repositórios/providers via suas interfaces e métodos de `Model`/`Value Object`. **Use case nunca chama outro use case** — lógica reaproveitável vira método de domínio (`Model`/VO) ou provider.
- **Repository/Provider**: interface declarada em `application/`, implementação em `infra/`. O módulo Nest faz o bind por token (`{ provide: EMAIL_REPOSITORY, useClass: PrismaEmailRepository }`) — essa indireção é a inversão de dependência que permite mockar com `vitest-mock-extended` nos testes `.unit.ts` sem tocar em Prisma.
- **Model**: entidade de domínio com invariantes e métodos de negócio; nunca é o tipo gerado pelo Prisma. A conversão `linha Prisma ↔ Model` é responsabilidade exclusiva do repositório (mapper privado).

## 3. Kernel DDD (`packages/ddd-kernel`)

Pacote novo, sem dependência de outros pacotes do monorepo além de `@ruguin/utils` (reexporta `Either`/`success`/`failure`) e libs externas (`uuid`). Mantém a direção de dependência de mão única: `ddd-kernel` depende de `utils`, `utils` nunca depende de `ddd-kernel`.

```
packages/ddd-kernel/
  src/
    errors/base-error.ts
    enums/status-error.enum.ts
    value-objects/id/
      id.value-object.ts
      errors/invalid-id.error.ts
      errors/generate-id.error.ts
      __tests__/id.value-object.unit.ts
    index.ts
```

### `StatusError`

Categoria semântica do erro de domínio — não é um código HTTP. Um `ExceptionFilter` global no `core-server` traduz `StatusError → HTTP status`, mantendo o domínio livre de conhecer HTTP:

```ts
export enum StatusError {
  INVALID_INPUT = 'INVALID_INPUT', // -> 400
  UNAUTHORIZED = 'UNAUTHORIZED', // -> 401
  FORBIDDEN = 'FORBIDDEN', // -> 403
  NOT_FOUND = 'NOT_FOUND', // -> 404
  CONFLICT = 'CONFLICT', // -> 409
  UNPROCESSABLE = 'UNPROCESSABLE', // -> 422
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS', // -> 429
  INTERNAL_ERROR = 'INTERNAL_ERROR' // -> 500
}
```

### `BaseError`

```ts
import { type StatusError } from '../enums'

export abstract class BaseError {
  readonly error?: unknown
  readonly message: string
  abstract readonly name: string
  abstract readonly status: StatusError

  protected constructor(input: { message: string; error?: unknown }) {
    this.error = input.error
    this.message = input.message
  }
}
```

### Hierarquia de erros por camada

Todo erro no `core-server` estende `BaseError`, mas cada camada tem sua própria família de erros, para o `Either` de cada função ser preciso quanto ao tipo de falha que pode retornar:

| Camada | Exemplos | Quem produz |
|---|---|---|
| Value Object | `InvalidIDError`, `InvalidEmailError` | Método estático do VO (`validate`/`create`) |
| Repository | `SaveEmailRepositoryError`, `FindProjectByIdRepositoryError` | Implementação Prisma, quando a query falha por motivo de infra |
| Use Case | `RequestEmailSendUseCaseError` (união dos erros que os passos internos produzem + erros de regra própria) | Use case, compondo os `Either` dos repos/VOs que chamou |

A camada `Service`/`Controller` só enxerga o `Either<UseCaseError, Output>` do use case — nunca sabe se a falha veio de um VO ou de um repositório, só que é um `BaseError` com um `status`.

### `ID` (Value Object)

Idêntico ao padrão de referência trazido para este design (baseado em UUID v7, `validate`/`generate` retornando `Either`, imutável via `Object.freeze`), adaptado para importar `Either`/`failure`/`success` de `@ruguin/utils` em vez de `@peatti/utils`.

## 4. Modelos de domínio (aggregates) e Repositórios

Bounded contexts do `core-server`, derivados do `product-spec.md` (seções 3.2 e 3.8):

| Bounded context | Aggregate root | Relação | Invariante-chave |
|---|---|---|---|
| `organization` | `Organization` | — | nome não vazio |
| `project` | `Project` | pertence a 1 `Organization` | `organizationId` obrigatório |
| `api-key` | `ApiKey` | pertence a 1 `Project` | valor em texto puro só existe na criação (nunca persistido); persiste-se o hash |
| `template` | `Template` | pertence a 1 `Project` | corpo HTML com placeholders `{{var}}` sintaticamente válidos |
| `domain` | `Domain` | pertence a 1 `Project` | status de verificação (`pending`/`verified`/`failed`) |
| `email` | `Email` | pertence a 1 `Project`; referencia `Template` opcionalmente | `(projectId, idempotencyKey)` único; `templateId`, se informado, deve pertencer ao mesmo `projectId` |

`Model` não conhece Prisma — é uma classe de domínio com invariantes validadas via `Either` no construtor estático (`Model.create(...)`), igual ao padrão do VO `ID`.

Repositório é sempre um par **interface (porta, em `application/repositories/`) + implementação (adapter, em `infra/database/prisma/`)**, ligado por bind de token no módulo Nest:

```ts
// email/application/repositories/email.repository.ts
export const EMAIL_REPOSITORY = Symbol('EMAIL_REPOSITORY')

export interface EmailRepository {
  save(input: { email: Email; tx?: Prisma.TransactionClient }):
    Promise<Either<SaveEmailRepositoryError, { emailSaved: Email }>>
  findByIdempotencyKey(input: { projectId: ID; idempotencyKey: string; tx?: Prisma.TransactionClient }):
    Promise<Either<FindEmailRepositoryError, { email: Email | null }>>
}
```

A implementação concreta (`PrismaEmailRepository`) mapeia erros de infra específicos (ex.: violação de constraint única do Postgres) para um erro de domínio próprio (ex.: `EmailIdempotencyConflictError` com `status: StatusError.CONFLICT`), em vez de deixar vazar um erro genérico do Prisma.

## 5. Transação (Unit of Work) + Outbox

### Mecanismo de transação — Unit of Work com `tx` explícito

Decisão: o use case controla o limite da transação via um `TransactionManager` (porta); cada método de repositório aceita um `tx?: Prisma.TransactionClient` opcional (usa o client transacional quando presente, o singleton do Prisma quando ausente).

Como `Prisma.$transaction(callback)` só faz rollback quando a callback lança uma exceção — e o código do use case usa `Either`, não exceptions, para falhas de negócio — é preciso uma ponte entre os dois mundos: uma classe interna `RollbackSignal` (não exportada de `shared/database/`, nunca um `BaseError`, nunca vaza para fora do `TransactionManager`), lançada dentro do callback quando um `Either` intermediário é `Failure`, e capturada logo na saída de `execute()` para devolver o `Failure` original como `Either` — quem chama o use case nunca vê uma exception.

```ts
// shared/database/transaction-manager.ts (interface)
export interface TransactionManager {
  execute<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<Either<BaseError, T>>
}
```

```ts
// shared/database/prisma-transaction-manager.ts (implementação)
@Injectable()
export class PrismaTransactionManager implements TransactionManager {
  constructor(private readonly prisma: PrismaService) {}

  public async execute<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<Either<BaseError, T>> {
    try {
      const value = await this.prisma.$transaction(work)
      return success(value)
    } catch (error: unknown) {
      if (error instanceof RollbackSignal) return failure(error.originalError)
      return failure(new TransactionError({ error }))
    }
  }
}
```

### Outbox — publicação de eventos atômica com a escrita de domínio

Em vez do use case publicar direto no Kafka (o que criaria uma transação distribuída implícita entre Postgres e Kafka), ele escreve na mesma transação Postgres uma linha numa tabela outbox compartilhada; um relay assíncrono publica de fato no Kafka depois do commit.

```prisma
model OutboxMessage {
  id          String       @id @default(uuid())
  topic       String
  key         String                       // chave de partição Kafka (ex.: emailId)
  payload     Json
  status      OutboxStatus @default(PENDING)
  attempts    Int          @default(0)
  createdAt   DateTime     @default(now())
  publishedAt DateTime?
  lastError   String?

  @@index([status, createdAt])
}

enum OutboxStatus {
  PENDING
  PUBLISHED
  FAILED
}
```

```ts
// shared/outbox/outbox.repository.ts (interface)
export interface OutboxRepository {
  enqueue(input: { message: { topic: string; key: string; payload: unknown }; tx?: Prisma.TransactionClient }):
    Promise<Either<EnqueueOutboxRepositoryError, { enqueued: true }>>
}
```

Exemplo de uso no use case (`RequestEmailSendUseCase`):

```ts
const result = await this.transactionManager.execute(async (tx) => {
  const existing = await this.emailRepository.findByIdempotencyKey({ projectId, idempotencyKey, tx })
  if (existing.isFailure()) throw new RollbackSignal(existing.value)
  if (existing.value.email) return existing.value.email

  const saved = await this.emailRepository.save({ email, tx })
  if (saved.isFailure()) throw new RollbackSignal(saved.value)

  const enqueued = await this.outboxRepository.enqueue({
    message: { topic: 'email.send.requested', key: email.id.toString(), payload: EmailSendRequestedMapper.toPayload(email) },
    tx
  })
  if (enqueued.isFailure()) throw new RollbackSignal(enqueued.value)

  return saved.value.emailSaved
})
```

### Relay do outbox

Componente técnico sem lógica de negócio, em `shared/outbox/outbox-relay.service.ts`:

- `@nestjs/schedule` com `@Interval(...)` (intervalo configurável, ex.: 500ms–1s).
- Lê um lote de mensagens `PENDING` com `SELECT ... FOR UPDATE SKIP LOCKED` (via `$queryRaw`), para que múltiplas instâncias do `core-server` não publiquem a mesma mensagem em duplicidade.
- Publica cada mensagem via a porta `KafkaProducerPort`, implementada em `packages/message-broker`.
- Sucesso → marca `PUBLISHED`. Falha → incrementa `attempts`; acima de um limite configurável, marca `FAILED` (equivalente a uma DLQ local, visível para reprocessamento manual pelo dashboard — alinhado à NFR 4.2/4.4 do product-spec).
- Garante semântica **at-least-once** por construção: se o processo cair entre publicar no Kafka e marcar `PUBLISHED`, a mensagem é republicada na próxima varredura — consistente com a exigência do product-spec de que todo consumidor seja idempotente por deduplicação.

## 6. Convenção de testes

Muda o padrão do `api-server` (arquivos ao lado do fonte, `.integration.ts` por extenso) para pasta `__tests__/` dedicada com `.int.ts`:

```ts
// vitest.config.ts
projects: [
  { extends: true, test: { name: 'unit', include: ['src/**/__tests__/**/*.unit.ts'], testTimeout: 5000 } },
  { extends: true, test: { name: 'integration', include: ['src/**/__tests__/**/*.int.ts'], testTimeout: 15_000 } },
  { extends: true, test: { name: 'e2e', include: ['src/**/__tests__/**/*.e2e.ts'], testTimeout: 30_000 } }
]
```

Os testes já existentes (`health.controller.e2e.ts`, `pino-http-options.unit.ts`, `create-tracing-sdk.unit.ts`, `decorator-metadata.unit.ts`) são movidos para dentro de um `__tests__/` correspondente como parte do rename (seção 1).

| Tipo | O que testa | Como |
|---|---|---|
| `.unit.ts` | Use case, Model, Value Object, Mapper | `vitest-mock-extended` (`mock<EmailRepository>()`, `mock<TransactionManager>()`) — zero I/O real, zero `TestingModule` do Nest |
| `.int.ts` | Repositório Prisma real, `OutboxRelayService` real | Postgres real via `infrastructure/local/docker-compose.yml` |
| `.e2e.ts` | Fluxo HTTP completo | `supertest` + `Test.createTestingModule`, Postgres + relay reais |

Regra prática: **um use case nunca tem `.int.ts`** — ele só depende de interfaces, nunca de infra concreta. Isso mantém a maior parte da lógica de negócio coberta por testes unitários rápidos, sem Postgres.

## Resumo de dependências novas

**`packages/ddd-kernel` (novo pacote):** depende de `@ruguin/utils` (workspace) + `uuid`.

**`apps/core-server` (dependencies novas):** `@ruguin/ddd-kernel` (workspace), `@prisma/client`, `@nestjs/schedule` (outbox relay).

**`apps/core-server` (devDependencies novas):** `prisma`, `vitest-mock-extended`.

## Riscos / pontos de atenção para a implementação

- **`RollbackSignal` não pode vazar**: se por engano ela for exportada ou capturada por um `catch` genérico em outra camada, um `Either.Failure` pode silenciosamente virar uma exception não tratada. Deve existir um teste `.unit.ts` do `PrismaTransactionManager` cobrindo explicitamente esse caminho.
- **`SKIP LOCKED` no relay do outbox** exige Postgres (confirmado, é o banco escolhido) — não funciona em todo banco relacional, mas não é um problema aqui.
- **Outbox como tabela cross-context**: como vive em `shared/`, precisa ficar claro na revisão de código que nenhum bounded context deve consultar `OutboxMessage` diretamente fora do `OutboxRepository`/relay — só escreve via `enqueue`.
- **Mapeamento de erro de constraint única do Prisma → `StatusError.CONFLICT`**: depende de inspecionar o código de erro do Prisma (`P2002`) corretamente em cada repositório que tem constraint de unicidade (idempotência de email, por exemplo) — fácil esquecer em um repositório novo e deixar vazar como `INTERNAL_ERROR` genérico.
- **Migração dos testes existentes para `__tests__/`**: mecânica, mas fácil esquecer de atualizar algum import relativo ao mover arquivo de pasta.
