# SES Webhook Ingestor — Design

**Data:** 2026-08-04
**Status:** Aprovado para planejamento de implementação
**Escopo:** Serviço `SES Webhook Ingestor`, hoje `[Planejado]` em `docs/product-spec.md` (seção 3.4) e na tabela de serviços de `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`.

## Contexto e objetivo

O `dispatch-worker` já envia emails via AWS SES e publica `email.status.updated` com `status=sent`/`failed`. O que falta é o outro lado: quando a SES efetivamente entrega, sofre bounce ou recebe uma reclamação (complaint) do destinatário, esse resultado chega de forma assíncrona e precisa virar um novo `email.status.updated` (`delivered`/`bounced`/`complained`) para o resto do sistema (Webhook Notifier e Read-Model Updater, ambos futuros) consumir.

Este design cobre um serviço novo, `apps/ses-webhook-ingestor`, que expõe um endpoint HTTP, recebe esses eventos, normaliza e publica no Kafka.

## Mudança em relação à spec original: transporte

A spec de 2026-07-28 previa SNS como transporte (assinatura de origem AWS, handshake de `SubscriptionConfirmation`). Esta versão substitui por **Amazon EventBridge**: a SES publica em um Event Bus via Configuration Set, uma Rule do EventBridge encaminha para uma **API Destination**, que faz o `POST` HTTP no nosso endpoint com autenticação simples (header fixo, configurado na *Connection* do lado AWS).

Isso elimina a verificação de assinatura X.509 e o handshake de subscription do SNS — a autenticação do endpoint vira um segredo compartilhado simples. Provisionar a Rule/Connection/API Destination na AWS é trabalho de infraestrutura (Terraform/CDK), fora do escopo deste design: aqui definimos apenas o contrato HTTP que o serviço expõe e espera receber.

## Decisão de arquitetura: correlação `sesMessageId → emailId`

A notificação da SES só carrega o `sesMessageId` (ID gerado pela AWS no envio); o contrato `email.status.updated` exige o `emailId` interno (UUID). Decisão: o Ingestor mantém uma **tabela de correlação própria no Postgres**, populada por um consumer Kafka de `email.status.updated` filtrando `status=sent` (evento que o `dispatch-worker` já publica com `emailId` + `sesMessageId`).

Isso corrige a tabela de arquitetura da spec de 2026-07-28 e a de `product-spec.md`, que hoje descrevem o Ingestor como não consumindo nenhum tópico Kafka — ambas serão atualizadas junto com este design (ver seção "Mudanças em documentos existentes").

Alternativa descartada: marcar o `SendEmailCommand` da SES com uma tag `emailId` (abordagem stateless, sem tabela nem consumer) — rejeitada em favor da tabela de lookup para não alterar o `dispatch-worker` já implementado e testado.

## Arquitetura

**Novo serviço**: `apps/ses-webhook-ingestor` — mesmo esqueleto do `dispatch-worker` (NestJS + `@nestjs/platform-fastify`, `nestjs-pino`, `@ruguin/cache`, `@ruguin/message-broker`), mais um schema Postgres próprio (Prisma 7, seguindo o padrão real de `apps/core-server` — não Drizzle, que é o que a spec original menciona mas o código real já divergiu disso).

| Componente | Papel |
|---|---|
| `POST /webhooks/ses` | Recebe a invocação da API Destination do EventBridge |
| Tabela de correlação (Postgres, schema próprio) | `(sesMessageId, emailId)`, populada de forma assíncrona |
| Consumer `email.status.updated` (filtro `status=sent`) | Faz upsert idempotente na tabela de correlação |
| Consumer do tópico de retry interno | Reprocessa notificações cujo lookup falhou na primeira tentativa |
| Redis (`@ruguin/cache`) | Claim de dedup por `id` do evento EventBridge em duas fases: lease curto na entrada, janela de 24h só depois do desfecho durável (ver "Reentrega do EventBridge") |
| Kafka producer | Publica `email.status.updated` (delivered/bounced/complained), tópico de retry e DLQ |

## Fluxo de dados

**A. Populando a correlação (contínuo, independente do HTTP):**

1. `dispatch-worker` publica `email.status.updated` (`status=sent`, `emailId` + `sesMessageId`) — sem mudança nesse serviço.
2. O consumer do Ingestor faz upsert idempotente `(sesMessageId, emailId)` na tabela de correlação (Kafka é at-least-once; upsert absorve redelivery).

**B. Recebendo uma notificação:**

1. EventBridge chama `POST /webhooks/ses` com o header de segredo compartilhado.
2. Header ausente/inválido → `401`, log de warning, nada publicado.
3. Claim de dedup no Redis pela chave = `id` do evento EventBridge, com um lease curto (60s) — não com a janela cheia de 24h.
   - Já reivindicado → `200` imediato, sem reprocessar.
4. Parseia o envelope (`source=aws.ses`, `detail.eventType` conhecido — `Delivery`/`Bounce`/`Complaint`, via união discriminada Zod) e extrai `detail` (JSON de Event Publishing da SES: `mail.messageId`, `eventType`, sub-objeto `bounce`/`complaint`/`delivery`).
5. Payload malformado (JSON inválido, `detail.eventType` desconhecido, campos obrigatórios faltando) → publica o corpo bruto + motivo em uma DLQ de ingestão (`ses.notification.malformed.dlq`), responde `200` (reentregar nunca vai corrigir um payload inválido).
6. Busca `emailId` na tabela de correlação pelo `sesMessageId`:
   - **Achou** → mapeia `eventType` → status (`Delivery→delivered`, `Bounce→bounced` + `bounceType`, `Complaint→complained`), publica `email.status.updated`, responde `200`.
   - **Não achou** → publica no tópico de retry interno (`attempt=1`, `nextAttemptAt`), responde `200` mesmo assim — a notificação foi aceita, a resolução continua async.
7. Desfecho durável (publicado ou retry agendado) → confirma o claim, estendendo o lease para a janela de dedup de 24h. A confirmação é best-effort: se ela falhar, o claim simplesmente expira com o lease e uma reentrega posterior é reprocessada — o pipeline é at-least-once de qualquer forma.
8. Falha ao publicar no Kafka (broker fora do ar etc.) → libera o claim do Redis (uma reentrega legítima não pode ser descartada como duplicata) e responde `5xx`, deixando a política de retry do EventBridge agir.

**C. Resolvendo o retry (consumer separado):**

1. Tenta o lookup de novo.
2. Achou → publica `email.status.updated`, encerra.
3. Não achou, tentativas restantes → republica no tópico de retry com backoff.
4. Esgotou tentativas → DLQ do tópico de retry, reprocessável manualmente (mesmo padrão de `email.send.requested.dlq`).

## Tratamento de erros e casos de borda

- **Header de auth inválido**: `401`, sem retry a incentivar — não é um problema de timing, é rejeição de origem.
- **Payload malformado**: DLQ de ingestão + `200`, nunca falha travando o endpoint nem gera retry infinito do EventBridge.
- **Reentrega do EventBridge**: absorvida pelo claim de dedup no Redis, em duas fases. O claim entra com um lease curto (60s) e só é estendido para a janela de 24h depois que o desfecho é durável — a política de retry do target (Rule/API Destination) provisionada no lado AWS precisa manter `maximumEventAgeInSeconds` menor ou igual a essa janela (em segundos) para que a garantia de dedup contra reentregas se sustente; uma reentrega que sobreviva ao TTL do claim reivindica de novo e publica um `email.status.updated` duplicado. O lease existe porque reivindicar as 24h de saída torna o claim refém do release: com o circuit breaker do cache aberto, `delete()` responde sucesso sem tocar no Redis (`packages/cache/src/infra/decorators/resilient-cache.provider.ts`), então uma chave real de 24h sobreviveria e toda reentrega dentro dela seria descartada como duplicata de um evento que nunca foi processado. Com o lease, o pior caso de qualquer caminho que morra entre claim e confirmação é um claim preso por ~60s.
- **Lookup nunca resolve**: DLQ do tópico de retry, cobre perda/atraso anômalo do evento `sent` original.
- **Falha ao publicar no Kafka**: mensagem não é dada como processada (claim liberado no caminho HTTP; offset não commitado nos consumers), reprocessamento seguro.
- **Duas notificações para o mesmo email** (ex.: `Delivery` seguido de `Bounce` tardio): cada uma publica seu próprio `email.status.updated` independente; reconciliação de histórico fica a cargo do Read-Model Updater (futuro), não deste serviço.

## Mudanças em contratos existentes

- `packages/event-schemas/src/email-status-updated.schema.ts`: adicionar `bounceType` opcional (`Permanent | Transient | Undetermined`) ao `EmailStatusUpdatedPayloadSchema`. Campo opcional — não quebra o `dispatch-worker`, que nunca o define.
- Novos tópicos de retry/DLQ da correlação pendente, centralizados em `packages/event-schemas` (mesmo padrão de `EMAIL_SEND_REQUESTED_RETRY_TOPIC`/`_DLQ_TOPIC`), com schema de payload próprio (sesMessageId, status já mapeado, bounceType, tentativa, `nextAttemptAt`):
  - `SES_NOTIFICATION_CORRELATION_RETRY_TOPIC` (`ses.notification.correlation.retry`) — passo B.6 ("não achou") e C.3 (backoff).
  - `SES_NOTIFICATION_CORRELATION_DLQ_TOPIC` (`ses.notification.correlation.dlq`) — passo C.4 (tentativas esgotadas).
  - `SES_NOTIFICATION_MALFORMED_DLQ_TOPIC` (`ses.notification.malformed.dlq`) — passo B.5 (payload malformado).

## Mudanças em documentos existentes

- `docs/product-spec.md` (seção 3.4 e tabela de serviços): corrigir "Consome de Kafka: —" → `email.status.updated`; corrigir autenticação do endpoint `/webhooks/ses` de "assinatura SNS" para segredo compartilhado via EventBridge API Destination.
- `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`: mesma correção na tabela de serviços e no fluxo de dados (item 3).

## Estratégia de testes

- **Unitários** (Vitest): mapeamento `eventType → status`, extração de `bounceType`, validação do header de auth (`timingSafeEqual`), lógica de dedup isolada.
- **Integração** (Testcontainers, Postgres/Kafka reais): consumer de `email.status.updated` populando a correlação; publish no tópico de retry quando o lookup falha; consumer de retry resolvendo depois.
- **E2E** (docker-compose completo): publica um `email.status.updated` sintético (`status=sent`) no Kafka, espera a correlação aparecer no Postgres, faz `POST /webhooks/ses` direto no endpoint com uma fixture do payload SES já no formato entregue pelo EventBridge, valida o `email.status.updated` resultante no Kafka. Não provisiona EventBridge real (AWS ou LocalStack) — testamos o contrato HTTP do serviço, não a fiação da AWS.
- **Contrato**: teste de schema Zod cobrindo o novo campo `bounceType`.

## Decisões em aberto para a implementação (não bloqueiam este design)

- Mecânica exata do schema Postgres próprio do novo serviço (schema Postgres dedicado vs. banco dedicado; wiring de `DATABASE_URL` por app) — resolver seguindo o padrão real já usado por `apps/core-server`.
- Provisionamento AWS real (Configuration Set da SES, Event Bus rule, Connection, API Destination) — infraestrutura, fora do escopo deste design de aplicação.
- Retenção/limpeza da tabela de correlação — sem TTL definido nesta primeira versão; revisitar se o volume justificar.

## Referências

- Spec de arquitetura original: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`
- Especificação de produto: `docs/product-spec.md`
- Ticket de referência do Dispatch Worker: `docs/tasks/EMAIL-5-dispatch-worker-ses.md`
- Contrato de eventos: `packages/event-schemas`
