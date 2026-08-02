# Dispatch Worker — Design

**Data:** 2026-08-02
**Status:** Aprovado para plano de execução
**Escopo:** `apps/dispatch-worker` (novo), `packages/event-schemas` (novo), `packages/message-broker` (novo), ajuste em `apps/core-server` (mover `MessageProducerPort` para o pacote compartilhado)

## Contexto e objetivo

`docs/product-spec.md` §2 lista o Dispatch Worker como [Ticketado: EMAIL-5]: consome `email.send.requested`, resolve rate limiting compartilhado entre instâncias, chama `SendEmail` da AWS SES (LocalStack em dev/teste), e publica `email.status.updated`. É a segunda metade do core send path — a primeira metade (`core-server` recebendo `POST /emails` e publicando o pedido via outbox) já está com a arquitetura de outbox pronta (`apps/core-server/src/shared/outbox/outbox-relay.service.ts`).

Nenhum dos dois pacotes que o Dispatch Worker exige para existir — o contrato de eventos (`docs/tasks/EMAIL-2-contrato-eventos-kafka.md`) e a implementação real de Kafka (hoje só há um fake de teste, `apps/core-server/src/shared/events/fake-message-producer.ts`) — foi construído ainda. Como nenhum outro serviço depende deles hoje, este design cobre os três de uma vez: `event-schemas`, `message-broker` e o próprio `dispatch-worker`.

O plano técnico original (`docs/superpowers/plans/2026-07-28-transactional-email-foundation-plan.md`) deixou explícito que retry com backoff de falha transitória da SES ficaria para um "hardening futuro" — este design incorpora esse retry agora, via fila dedicada, em vez de adiar de novo.

## Fora de escopo

- SES Webhook Ingestor, Tracking Service, Webhook Notifier, Read-Model Updater — outros serviços do roadmap (`docs/product-spec.md` §2).
- CRUD de gestão de conta — dados de organização/projeto/API key/template seguem seedados diretamente no banco do `core-server`, como no plano original.
- Anexos e verificação de domínio (SPF/DKIM/DMARC) — decisões em aberto do produto, não deste serviço.
- Supressão automática de endereço por bounce/complaint (`docs/product-spec.md` §3.9) — depende do SES Webhook Ingestor, fora deste design.

## Arquitetura

### `packages/event-schemas`

Fonte única de verdade para nome de tópico e formato de payload — nenhum outro pacote escreve nome de tópico "à mão".

- Schemas Zod: `EmailSendRequestedSchema`, `EmailStatusUpdatedSchema`, `EmailEngagementSchema` (reservado, ver `docs/tasks/EMAIL-2-contrato-eventos-kafka.md`).
- Envelope padrão de mensagem: `{ eventId: string (uuid), name: string, payload: T }` — mesmo formato que `OutboundMessage` já usa em `apps/core-server/src/shared/contracts/message-producer.port.ts`.
- Constantes de tópico: `EMAIL_SEND_REQUESTED_TOPIC`, `EMAIL_SEND_REQUESTED_RETRY_TOPIC`, `EMAIL_SEND_REQUESTED_DLQ_TOPIC`, `EMAIL_STATUS_UPDATED_TOPIC` (+ `.dlq`), `EMAIL_ENGAGEMENT_TOPIC` (+ `.dlq`).
- Todo timestamp em ISO 8601 UTC (`Z`), sem offset de fuso.

### `packages/message-broker`

Adapter `@platformatic/kafka` (com instrumentação OpenTelemetry via `@platformatic/kafka-opentelemetry`), único ponto do monorepo que fala com Kafka de verdade.

- `MessageProducerPort` — **movido** de `apps/core-server/src/shared/contracts/message-producer.port.ts` para cá. É infraestrutura compartilhada entre apps, não deveria morar dentro de um único app; o `core-server` passa a importar o port daqui e a injetar a implementação real via `@platformatic/kafka` (hoje só tem o fake de teste).
- `MessageConsumerPort` (novo) — `subscribe({ topic, groupId, onMessage })`, retorna o envelope `{ eventId, name, payload, headers }` já desserializado. Deliberadamente genérico: não sabe nada sobre retry ou backoff — isso é lógica de aplicação de quem consome, para que o Webhook Notifier e o Read-Model Updater possam reaproveitar o mesmo port depois sem herdar a semântica de retry específica do Dispatch Worker.

### `apps/dispatch-worker`

NestJS (mesma stack do `core-server`, por consistência de padrão de projeto e testes) — sem rotas HTTP de domínio, só `GET /health` (Terminus, igual ao `core-server`) para o healthcheck do docker-compose. Sem schema Postgres próprio: todo estado (rate limit, dedup, retry) vive no Redis via `@ruguin/cache`.

```
apps/dispatch-worker/src/
  email/                                       # único bounded context deste app
    application/
      use-cases/
        send-email.use-case.ts                 # orquestra: claim -> rate limit -> SES -> publica status/retry
      providers/
        rate-limiter.port.ts
        email-sender.port.ts                   # abstrai SES/LocalStack
    infra/
      redis/
        redis-rate-limiter.ts                  # token bucket via @ruguin/cache
        redis-dedup-claim.ts                    # claim curto por emailId
      ses/
        ses-email-sender.ts                    # @aws-sdk/client-ses
    consumers/
      email-send-requested.consumer.ts         # assina email.send.requested
      email-send-requested-retry.consumer.ts   # assina email.send.requested.retry
    email.module.ts
    __tests__/
      *.unit.ts *.int.ts *.e2e.ts
  health/                                       # igual ao core-server
  main.ts app.module.ts
```

## Fluxo de dados: processar um pedido de envio

1. `email-send-requested.consumer.ts` recebe `email.send.requested`. `send-email.use-case.ts` reivindica um claim no Redis por `emailId` (TTL curto) — se já reivindicado, descarta silenciosamente (reentrega at-least-once do Kafka).
2. Verifica o token bucket no Redis (limite compartilhado da conta SES entre todas as instâncias do worker).
3. Chama `SendEmail` da SES (LocalStack em dev/teste).
4. **Sucesso** → publica `email.status.updated` com `status=sent` + `sesMessageId`.
5. **Falha transitória** → publica em `email.send.requested.retry` com `attempt` incrementado e `nextAttemptAt` (backoff exponencial: base × 2^attempt, mesma fórmula de `computeNextAttemptAt` em `outbox-relay.service.ts` — sem jitter, por consistência com o único outro backoff já implementado no monorepo).
6. `email-send-requested-retry.consumer.ts` recebe a mensagem de retry: se `now < nextAttemptAt`, aguarda a diferença antes de processar (consumer dedicado — não compete com o tópico principal, então uma espera aqui não atrasa novos pedidos de envio); então repete os passos 2–5.
7. Esgotadas 3 tentativas de retry (~10s / ~20s / ~40s de espera) → publica `email.status.updated` com `status=failed` **e** envia a mensagem original para `email.send.requested.dlq`, visível para inspeção/reprocessamento manual.
8. Mensagem malformada (não valida contra o schema Zod) vai direto para o `.dlq` correspondente, sem entrar no ciclo de retry — nunca trava o processamento das mensagens seguintes.

## Rate limiting e idempotência

- **Rate limit**: token bucket em Redis (`@ruguin/cache`, driver Valkey já existente), refletindo o limite real de requisições/segundo e a cota diária da conta SES — fonte de tempo compartilhada entre instâncias, nunca relógio local do processo (`docs/product-spec.md` §4.2).
- **Idempotência/dedup**: claim Redis de TTL curto por `emailId`, protegendo contra reprocessamento da mesma mensagem sob a semântica at-least-once do Kafka.

## Estratégia de testes

- **Unitários** (Vitest): `send-email.use-case.ts` com providers mockados (`vitest-mock-extended`), cálculo de backoff, validação dos schemas Zod de `event-schemas`.
- **Integração** (Vitest, contra o stack `docker-compose` real — Kafka/Redis/LocalStack, não Testcontainers, mesmo padrão do `core-server`): consumer principal publicando em `email.send.requested` e verificando que `email.status.updated` sai correto; forçar falha transitória e verificar a passagem pela fila de retry até esgotar e cair na DLQ.
- **Ponta a ponta**: reaproveita o teste do EMAIL-6 (`POST /emails` no core-server → `email.status.updated` com `status=sent`), agora com o Dispatch Worker real processando em vez de faltar essa metade do pipeline.

## Decisões em aberto para a próxima fase (não bloqueiam este design)

- Retry de entrega de webhook (Webhook Notifier) pode reaproveitar o mesmo padrão de fila única + `nextAttemptAt`, ou usar filas escalonadas por tentativa — decisão fica para a spec desse serviço.
- Observabilidade entre serviços (tracing distribuído via OpenTelemetry) através do Kafka — recomendado, ferramenta específica fica para decisão na implementação, igual à spec original do produto.
- Métrica de volume por tentativa de retry (quantos emails precisam de 1ª/2ª/3ª tentativa) — útil para revisar os tempos de backoff depois de dados reais, não bloqueia a implementação inicial.
