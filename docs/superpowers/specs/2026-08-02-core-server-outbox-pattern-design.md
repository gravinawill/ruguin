# Core Server — Outbox pattern por módulo — Design

**Data:** 2026-08-02
**Escopo:** `apps/core-server` (`shared/outbox`, `shared/events`), `packages/ddd-kernel` (`Event<T>`)

## Contexto

O spec de 2026-07-29 definiu o mecanismo original de outbox (tabela `OutboxMessage`,
`OutboxRepository.enqueue`, `OutboxRelayService` com `SKIP LOCKED`). O spec de 2026-08-01 aplicou a
migração da tabela, mas deixou `OutboxRepository`/`OutboxRelayService` explicitamente fora de escopo,
por terem "lógica substancial própria... e merecer plano próprio". Este é esse plano.

O mesmo spec de 2026-08-01 (decisão 6) registrou uma tensão ainda em aberto: a tabela outbox é
cross-module por natureza, sem lugar óbvio no padrão "um `.prisma` por módulo" que o resto do projeto
segue. Este design resolve essa tensão mantendo uma única tabela física, mas dando a cada módulo um
port lógico próprio sobre ela.

## Objetivo

Definir: (1) um modelo `Event<T>` genérico no kernel para os módulos declararem eventos de domínio;
(2) o esquema físico da tabela outbox, incluindo particionamento para conter seu crescimento; (3) o
relay que publica com garantia de ordem por `(module, key)`; (4) a rotina de manutenção de partições.

Não implementa o producer Kafka real (`packages/message-broker` continua vazio) nem nenhuma feature
de domínio — só a infraestrutura do outbox em si.

## Decisões

### 1. `Event<T>` no `ddd-kernel` — envelope genérico, sem `AggregateRoot`

Uma classe concreta, não abstrata, instanciada via factory. Cada módulo só declara o tipo do payload
e uma constante com o nome do evento — sem subclasse por evento:

```ts
// packages/ddd-kernel/src/event.ts
export class Event<TPayload> {
  private constructor(
    readonly id: ID,
    readonly name: string,
    readonly payload: TPayload,
    readonly occurredAt: Date,
  ) {}

  static create<TPayload>(name: string, payload: TPayload): Event<TPayload> {
    // ID.generate() é Either, mas falha de geração de UUID v7 é praticamente
    // impossível — unwrap direto aqui, tratando como bug (convenção do projeto)
    return new Event(unwrapId(ID.generate()), name, payload, new Date())
  }
}
```

```ts
// modules/health/domain/events/health-degraded.event.ts
export type HealthDegradedPayload = { service: string; reason: string }
export const HEALTH_DEGRADED_EVENT = 'health.degraded'
export const createHealthDegradedEvent = (payload: HealthDegradedPayload) =>
  Event.create(HEALTH_DEGRADED_EVENT, payload)
```

Alternativa recusada: subclasse por tipo de evento (`class UserCreatedEvent extends Event<...>`).
Rejeitada por adicionar boilerplate por evento sem necessidade hoje — o kernel atual (`BaseError`,
`ID`) já é minimalista, e não há lógica específica de evento a esconder numa subclasse ainda.

Também recusado: `AggregateRoot` com fila de eventos pendentes (`pullEvents()`). O kernel não tem
`AggregateRoot` hoje, e retrofitar essa abstração exigiria desenhar um conceito novo do zero só para
este plano. `Event<T>` isolado, enfileirado diretamente pelo use case, resolve sem essa dependência.

### 2. Tabela única compartilhada, port lógico por módulo

A `OutboxMessage` já migrada continua sendo uma tabela física só, com uma coluna `module` nova. Cada
módulo declara seu próprio port (`OutboxPort`) e faz o bind via DI para uma implementação
(`OutboxRepository`) parametrizada com o nome do módulo:

```ts
// shared/domain/contracts/outbox.port.ts
export interface OutboxPort {
  enqueue<TPayload>(
    event: Event<TPayload>,
    options: { topic: string; key: string },
    tx: TransactionContext,
  ): Promise<Either<BaseError, void>>
}
```

```ts
// modules/health/health.module.ts
providers: [{ provide: OUTBOX_PORT, useFactory: () => new OutboxRepository('health') }]
```

Alternativa recusada: tabela física por módulo (schema `.prisma` próprio por módulo, ex.:
`health_outbox`). Reforçaria isolamento físico, mas exige múltiplos relays (ou um relay genérico
iterando N tabelas) e abandona a migração já aplicada, sem resolver sozinha o problema de crescimento
(ver decisão 5).

### 3. Enqueue direto do use case, na mesma transação

Sem indireção de agregado — o use case chama o port explicitamente dentro do callback do
`TransactionManager.execute()`, depois de persistir a mudança de domínio:

```ts
async execute(input): Promise<Either<BaseError, Output>> {
  return this.transactionManager.execute(async (tx) => {
    const aggregate = await this.repository.save(input, tx)
    const event = createHealthDegradedEvent({ service, reason })
    const enqueued = await this.outbox.enqueue(event, { topic: 'health-events', key: aggregate.id }, tx)
    if (isFailure(enqueued)) return enqueued
    return success(aggregate)
  })
}
```

Atomicidade vem do `TransactionManager` já existente (spec 2026-08-01) — sem transação distribuída,
tudo no mesmo commit Postgres.

### 4. `eventId` separado da `key` de partição Kafka

São conceitos com cardinalidade diferente: `key` identifica o agregado e é compartilhada por vários
eventos dele ao longo do tempo (é o que sustenta a ordenação, decisão 6); `eventId` (o `Event.id`) é
único por instância de evento, usado para deduplicação no consumer quando o relay publica a mesma
linha duas vezes (ver decisão 7, semântica at-least-once). Misturar os dois impediria usar a mesma
`key` em múltiplos eventos do mesmo agregado.

### 5. Particionamento `RANGE` por `createdAt`, mensal

Partições por mês de criação. O relay só toca linhas `PENDING`, que ficam quase sempre na partição
mais recente — o planner do Postgres exclui partições antigas automaticamente (constraint exclusion),
então o `SKIP LOCKED` continua rápido mesmo com histórico grande. Retenção vira `DROP PARTITION`
(instantâneo) em vez de `DELETE` (gera bloat, precisa de vacuum).

Alternativa recusada: `LIST` por `module`. Não resolve sozinha o problema de crescimento — um módulo
muito ativo ainda teria uma partição sem limite. Combinar os dois níveis (`LIST` module + `RANGE`
createdAt dentro de cada) resolveria, mas é bem mais complexo de migrar e manter sem suporte
declarativo do Prisma; fica para revisitar só se um módulo específico crescer desproporcionalmente.

**Consequência técnica**: Postgres exige que toda chave primária e índice único de uma tabela
particionada inclua a coluna de particionamento. Por isso `id` e `eventId` viram compostos com
`createdAt` no schema abaixo — não é opcional.

```prisma
model OutboxMessage {
  id            String       @default(uuid())
  eventId       String       // Event.id — idempotência/dedup no consumer
  module        String
  topic         String
  key           String       // partição/ordenação Kafka (ex: id do agregado)
  name          String       // nome do evento, ex: 'health.degraded'
  payload       Json
  status        OutboxStatus @default(PENDING)
  attempts      Int          @default(0)
  nextAttemptAt DateTime?
  createdAt     DateTime     @default(now())
  publishedAt   DateTime?
  lastError     String?

  @@id([id, createdAt])
  @@unique([eventId, createdAt])
  @@index([status, createdAt])
  @@index([module, key, status, createdAt])
  @@index([status, publishedAt])
}
```

Como o Prisma não declara `PARTITION BY` nativamente, a migration nasce via `prisma migrate dev`
normal e é editada à mão para adicionar a cláusula de particionamento e as partições iniciais (mês
atual + os 2 seguintes).

### 6. Ordem garantida por `(module, key)` via window function

Índice `[module, key, status, createdAt]` sustenta uma query que seleciona só a mensagem mais antiga
`PENDING` de cada `(module, key)` como elegível:

```sql
-- dentro de uma CTE, antes do FOR UPDATE SKIP LOCKED
ROW_NUMBER() OVER (PARTITION BY module, key ORDER BY createdAt) AS rn
-- elegível: rn = 1 AND status = 'PENDING' AND (nextAttemptAt IS NULL OR nextAttemptAt <= now())
```

Combinado com `FOR UPDATE SKIP LOCKED`, isso garante que nunca duas mensagens da mesma key sejam
publicadas fora de ordem, mesmo com múltiplas instâncias do relay: só existe uma linha elegível por
key a cada momento, e a próxima só vira elegível depois que a anterior for marcada `PUBLISHED`. Uma
segunda instância que tentar pegar a mesma linha é bloqueada pelo `SKIP LOCKED` e simplesmente pula —
comportamento correto aqui, já que não há linha alternativa daquela key para processar.

### 7. `OutboxRelayService` — retry com backoff, DLQ local

`@nestjs/schedule` com `@Interval` (ex.: 500ms–1s, configurável), em
`shared/infrastructure/outbox/outbox-relay.service.ts`:

- Roda a query da decisão 6, trava as linhas selecionadas com `FOR UPDATE SKIP LOCKED`.
- Publica cada uma via `MessageProducerPort.publish(topic, key, { eventId, name, payload })` — porta
  nova em `shared/domain/contracts/`, implementada por um fake in-memory neste plano (decisão 9).
- Sucesso → `status = PUBLISHED`, `publishedAt = now()`.
- Falha → `attempts++`; acima de um limite configurável (padrão sugerido: 5 tentativas), `status =
  FAILED` (DLQ local, investigável manualmente); abaixo do limite, `nextAttemptAt = now() +
  backoff(attempts)` (exponencial), permanece `PENDING`.
- Semântica **at-least-once** por construção: se o processo cair entre publicar no Kafka e marcar
  `PUBLISHED`, a mensagem é republicada na próxima varredura — é para isso que existe o `eventId`
  (decisão 4), consumido no lado do consumer para deduplicar.

### 8. Manutenção de partições e retenção

Job mensal (`shared/infrastructure/outbox/outbox-partition-maintenance.service.ts`) cria a partição
do mês seguinte com antecedência de segurança (ex.: uma semana antes da virada) — sem isso, um
`INSERT` que caia fora do range de partições existentes falha.

Retenção via `DROP PARTITION` de meses mais antigos que um limite configurável (padrão sugerido: 3
meses). Só dropa partições sem nenhuma linha `PENDING`/`FAILED` remanescente — `PUBLISHED` sozinha não
é suficiente para decidir, porque dropar uma partição com mensagem ainda não publicada perderia o
evento de forma silenciosa.

### 9. `MessageProducerPort` com fake — producer Kafka real fica para depois

`packages/message-broker` está vazio hoje (só valida env). Este plano define a porta
(`MessageProducerPort.publish(topic, key, payload)`) e uma implementação fake in-memory para testes e
para o relay funcionar de ponta a ponta sem depender do Kafka real. O producer de verdade (client
`kafkajs` ou similar) é um plano próprio, plugado depois via DI sem tocar no relay.

## Testes

- **Unit**: `OutboxRepository` (Prisma tx mockada), `Event.create`, cálculo de backoff.
- **Unit**: `OutboxRelayService` com `MessageProducerPort` fake — sucesso, falha com retry, falha
  definitiva → `FAILED`.
- **Integration/e2e** (Postgres real via docker-compose):
  - Atomicidade: rollback do use case não deixa linha na outbox.
  - Ordenação: duas instâncias concorrentes do relay não invertem a ordem de mensagens da mesma
    `(module, key)`.
  - Partição: `INSERT` cai numa partição que o job de manutenção já criou com antecedência.

## Fora de escopo

- Producer Kafka real em `packages/message-broker` (fica só `MessageProducerPort` + fake).
- `AggregateRoot`/fila de eventos pendentes no kernel — `Event<T>` resolve por ora (decisão 1).
- Particionamento por `module` (`LIST`) — revisitar só se um módulo crescer desproporcionalmente
  (decisão 5).
- Automação de criação de partição via `pg_partman` ou extensão equivalente — começa com o job caseiro
  simples (decisão 8).
- Features de domínio que consumiriam o outbox — nenhum módulo de negócio existe ainda.

## Riscos

- **Drift entre schema Prisma e SQL real de particionamento.** O Prisma não declara `PARTITION BY`;
  a migration final é editada à mão. Sem documentação clara do processo, uma migration futura gerada
  automaticamente pode tentar recriar a tabela sem as partições.
- **Job de manutenção de partição é um ponto único de falha silenciosa.** Se não rodar, `INSERT` falha
  só quando o mês vira e não há partição para receber a linha — precisa de alerta/observability desde
  o início, não é um caminho que se descobre em produção.
- **Query de seleção ordenada (window function + `SKIP LOCKED`) é incomum.** Precisa de teste de
  concorrência real (múltiplas instâncias do relay rodando ao mesmo tempo), não só teste unitário
  sequencial.
- **`eventId` correto depende de todo enqueue passar por `Event.create`.** Se algum caller construir
  o payload sem usar o kernel, o dedup do consumer perde a garantia. Mitigado mantendo `OutboxPort`
  só aceitando `Event<T>`, nunca um objeto solto.
