# SaaS de Envio de Email Transacional — Design

**Data:** 2026-07-28
**Status:** Aprovado para planejamento de implementação
**Escopo:** Núcleo transacional (API de envio). Marketing/campanhas fica para uma spec futura separada.

## Contexto e objetivo

Construir um SaaS de envio de email transacional (estilo Resend/Postmark), em Node.js + TypeScript, para uso inicial nos próprios produtos do autor, com arquitetura multi-tenant desde o início (para permitir abrir para terceiros no futuro sem retrabalho).

Além do objetivo de produto, este projeto é explicitamente um veículo de aprendizado de arquitetura de microsserviços orientada a eventos com Kafka — isso justifica escolhas de design (número de serviços, uso de Kafka como backbone) que seriam over-engineering para o volume de envio esperado inicialmente, mas que têm valor educacional deliberado.

O envio real de emails é delegado à AWS SES (não construímos MTA próprio) — foco do produto é a camada de API, orquestração, templates, tracking e observabilidade de entrega.

## Fora de escopo (nesta spec)

- Editor de campanhas de marketing, gestão de listas de contatos, agendamento de broadcasts em massa. Estes formam um sub-projeto separado a ser especificado depois, construído sobre a base transacional aqui definida.
- MTA/infraestrutura de envio própria — usamos AWS SES.

## Arquitetura

### Backbone de eventos: Apache Kafka (via Docker, modo KRaft)

Tópicos principais:

- `email.send.requested` — pedido de envio validado, pronto para processamento.
- `email.status.updated` — mudanças de status do email (`sent`, `delivered`, `bounced`, `complained`, `failed`).
- `email.engagement` — eventos de abertura e clique.

Cada tópico tem um tópico `.dlq` (dead letter) correspondente para mensagens que esgotaram as tentativas de retry.

### Serviços

Seis serviços, cada um separado por uma característica operacional distinta (não por "tipo de entidade") — throughput, latência exigida, ou padrão de falha diferente dos demais:

| Serviço | Responsabilidade | Consome de Kafka | Produz em Kafka |
|---|---|---|---|
| **API Service** | Autenticação via API key, endpoint de envio (`POST /emails`), CRUD de templates/domínios/projetos/orgs, endpoints de leitura para o dashboard (BFF) | — | `email.send.requested` |
| **Dispatch Worker** | Resolve template, aplica rate limiting (Redis), chama `SendEmail` da AWS SES, trata retry/backoff | `email.send.requested` | `email.status.updated` |
| **SES Webhook Ingestor** | Recebe notificações SNS da AWS (delivery/bounce/complaint) via HTTP, normaliza o payload | HTTP (SNS) | `email.status.updated` |
| **Tracking Service** | Endpoints públicos de pixel de abertura e redirecionamento de clique — precisa responder em milissegundos | HTTP público | `email.engagement` |
| **Webhook Notifier** | Entrega webhooks assinados (HMAC-SHA256) para os endpoints configurados pelos clientes, com retry/backoff | `email.status.updated`, `email.engagement` | HTTP de saída (webhooks do cliente) |
| **Read-Model Updater** | Consome todos os tópicos e mantém as tabelas de leitura no Postgres que alimentam o dashboard | todos os tópicos | escreve no Postgres |

### Armazenamento

- **Postgres**: fonte de verdade (orgs, projetos, API keys, domínios verificados, templates) + tabelas de leitura (emails, eventos de status/engajamento). Cada serviço possui seu próprio *schema* Postgres dentro da mesma instância (isolamento lógico sem overhead operacional de múltiplos bancos) — nenhum serviço lê tabelas de outro schema diretamente; toda comunicação entre serviços é via eventos Kafka ou, no caso do dashboard, via API Service.
- **Redis**: rate limiting (token bucket por API key e pelo limite de conta do SES), cache de autenticação de API key, controle de idempotência de envio, lookup de baixa latência de IDs de tracking.

### Stack técnica

- **Linguagem/runtime**: TypeScript, Node.js LTS.
- **Framework HTTP**: Fastify (validação de schema, performance, ecossistema de plugins).
- **Cliente Kafka**: KafkaJS.
- **ORM**: Drizzle ORM (TypeScript-first, migrations via `drizzle-kit`).
- **Validação e contratos de evento**: Zod, com os schemas dos payloads Kafka centralizados em um pacote compartilhado (`packages/event-schemas`) importado por todos os produtores/consumidores.
- **Cache/rate limiting**: Redis via `ioredis`.
- **Monorepo**: pnpm workspaces + Turborepo — cada serviço em `apps/<nome>`, código compartilhado (schemas de evento, tipos, clientes internos) em `packages/`.
- **Infra local de desenvolvimento**: Docker Compose com Kafka (KRaft, sem ZooKeeper), Postgres, Redis, e LocalStack para simular a API da AWS (SES) sem custo real nem risco de enviar emails de teste.

## Fluxo de dados: enviar um email

1. **Cliente → API Service**: `POST /emails` com API key, `templateId` + variáveis (ou HTML bruto), destinatário, remetente, e opcionalmente um header `Idempotency-Key`. O API Service autentica a key (cache Redis), valida o payload (Zod), verifica idempotência, grava o registro no Postgres com `status=queued` e publica em `email.send.requested`.
2. **Dispatch Worker** consome o evento, verifica o token bucket no Redis (limite de taxa da conta SES), resolve o template lendo do Postgres e renderizando as variáveis, chama `SendEmail` da AWS SES.
   - Sucesso → publica `email.status.updated` com `status=sent` e o `sesMessageId`.
   - Falha transitória → retry com backoff exponencial.
   - Falha permanente → publica `status=failed`.
3. **AWS SES** processa a entrega e notifica de forma assíncrona via SNS (delivered/bounce/complaint) → o **SES Webhook Ingestor** recebe via HTTP, normaliza, e publica em `email.status.updated`.
4. Quando o destinatário abre o email ou clica em um link, a requisição passa pelo **Tracking Service** (pixel de 1x1 / redirecionamento de link), que publica em `email.engagement` antes de servir a imagem ou redirecionar.
5. O **Read-Model Updater** consome todos os tópicos acima e atualiza as tabelas de leitura no Postgres.
6. O **Webhook Notifier** consome `email.status.updated` e `email.engagement`, busca a URL de webhook configurada para o projeto do cliente, e entrega um POST assinado (HMAC) com o payload do evento.
7. O dashboard consulta o **API Service**, que por sua vez consulta as tabelas de leitura mantidas pelo Read-Model Updater.

## Tratamento de erros

- **Idempotência de envio**: header `Idempotency-Key` — o API Service verifica no Redis/Postgres antes de criar um registro duplicado de email.
- **Rate limiting do SES**: token bucket no Redis espelhando o limite real de requisições/segundo e cota diária da conta SES. O Dispatch Worker atrasa o processamento (não descarta) quando o limite é atingido.
- **Retry + Dead Letter Topic**: consumidores Kafka fazem retry com backoff exponencial; após um número máximo de tentativas, a mensagem é publicada no tópico `.dlq` correspondente, visível no dashboard para inspeção e reprocessamento manual.
- **Semântica at-least-once**: Kafka garante entrega "pelo menos uma vez" — todo consumidor é desenhado para ser seguro contra reprocessamento do mesmo evento (deduplicação por `eventId`).
- **Supressão automática de endereços**: bounce definitivo (hard bounce) ou complaint marca o endereço de destino como suprimido; envios futuros para esse endereço são bloqueados no API Service antes de chegar ao SES, protegendo a reputação do remetente.
- **Entrega de webhooks**: backoff exponencial com jitter, máximo de ~5 tentativas ao longo de ~1 hora; após esgotar as tentativas, a entrega é marcada como falha e pode ser reenviada manualmente pelo dashboard.

## Estratégia de testes

- **Unitários** (Vitest): lógica pura — renderização de template, assinatura HMAC de webhook, algoritmo do token bucket, validação de schemas Zod.
- **Integração por serviço** (Testcontainers): cada serviço testado contra instâncias efêmeras reais de Kafka/Postgres/Redis, validando o ciclo "consome evento X → produz evento Y" ou "consome evento → persiste no banco".
- **Contrato de eventos**: schemas Zod compartilhados em `packages/event-schemas` — mudanças que quebram o contrato entre produtor e consumidor quebram o build de compilação, não o comportamento em produção.
- **Ponta a ponta**: ambiente docker-compose completo com LocalStack no lugar da AWS real — dispara `POST /emails` e valida que o email chega a `status=sent` e que o dashboard reflete a mudança, sem custo de AWS nem envio real de email.
- **Carga/rate limit**: teste dedicado que gera um burst de envios e verifica que o Dispatch Worker nunca excede o token bucket configurado.

## Decisões em aberto para a próxima fase (não bloqueiam este design)

- Suporte a anexos (attachments) e armazenamento em S3 — não detalhado nesta spec; a adicionar quando o fluxo básico estiver funcionando.
- Verificação de domínio (SPF/DKIM/DMARC) — o fluxo de UX de verificação de domínio será detalhado no plano de implementação, não nesta spec de arquitetura.
- Observabilidade entre serviços (tracing distribuído via OpenTelemetry) — recomendado, mas a ferramenta específica (Honeycomb, Jaeger, etc) fica para decisão na implementação.
