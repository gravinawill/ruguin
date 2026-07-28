# Overview — Transactional Email Foundation & Core Send Path

**Plano completo:** `docs/superpowers/plans/2026-07-28-transactional-email-foundation-plan.md`
**Spec de arquitetura:** `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`

Este diretório quebra o plano acima em uma task por arquivo, cada uma autocontida (contexto, arquivos, interfaces, passos com código completo), para ser distribuída e executada individualmente.

## Ordem e dependências

| # | Task | Depende de |
|---|---|---|
| 1 | [Monorepo scaffolding](01-monorepo-scaffolding.md) | — |
| 2 | [Docker Compose dev infra](02-docker-compose-infra.md) | 1 |
| 3 | [Shared event-schemas package](03-event-schemas-package.md) | 1 |
| 4 | [API Service — scaffold + health](04-api-service-scaffold.md) | 1 |
| 5 | [API Service — Postgres schema + Drizzle](05-api-service-postgres-schema.md) | 2, 4 |
| 6 | [API Service — Redis + auth de API key](06-api-service-auth.md) | 2, 5 |
| 7 | [API Service — Kafka producer + templates](07-api-service-kafka-templates.md) | 2, 3, 6 |
| 8 | [API Service — `POST /emails`](08-api-service-post-emails.md) | 5, 6, 7 |
| 9 | [Dispatch Worker — scaffold + rate limiter](09-dispatch-worker-scaffold.md) | 1, 2 |
| 10 | [Dispatch Worker — SES + consumer](10-dispatch-worker-ses-consumer.md) | 2, 3, 9 |
| 11 | [Teste ponta a ponta](11-end-to-end-smoke-test.md) | 8, 10 |

## Escopo e o que fica de fora

Este conjunto de tasks entrega **só o caminho central de envio**: `POST /emails` → Kafka → Dispatch Worker → AWS SES (via LocalStack em dev/teste). Ao final da Task 11, um email enviado pela API chega comprovadamente à SES e gera um evento `email.status.updated` com `status: "sent"`.

**Fora de escopo (fica para um próximo plano):**
- SES Webhook Ingestor, Tracking Service, Webhook Notifier, Read-Model Updater — os tópicos Kafka que eles vão consumir (`email.status.updated`, `email.engagement`) já existem a partir da Task 3, então essas tasks futuras são só aditivas.
- CRUD de orgs/projetos/API keys/templates via API — os testes destas tasks semeiam esses dados diretamente no Postgres via Drizzle. A única rota exposta ao final é `POST /emails` (+ `GET /health`).
- Anexos/S3, verificação de domínio (SPF/DKIM/DMARC), tracing distribuído — explicitamente adiados na spec original.
- Retry com backoff exponencial para falhas transitórias da SES — o Dispatch Worker (Task 10) já protege contra mensagem malformada (DLQ) e contra reenvio duplicado (dedup via Redis), mas uma falha transitória da SES hoje é reportada uma única vez como `status: failed`, sem novas tentativas.

## Correções aplicadas após revisão por subagents

Este conjunto de tasks passou por uma auditoria técnica (3 subagents em paralelo, usando `context7` para validar APIs de bibliotecas e busca na web para validar decisões de infraestrutura) antes da implementação começar. Os problemas reais encontrados e corrigidos:

- **Bug bloqueante:** `CLUSTER_ID` do Kafka no `docker-compose.yml` (Task 2) era uma string inválida para KRaft — o container não subiria. Corrigido (removido; a imagem gera um válido sozinha).
- **Risco real:** rate limiter do Dispatch Worker (Task 9) calculava o tempo no cliente (`Date.now()`) em vez de usar o relógio do próprio Redis — sob múltiplas instâncias do worker com relógios dessincronizados, o limite de envio ficaria incorreto. Corrigido (usa `redis.call('TIME')` dentro do script Lua).
- **Bug real:** condição de corrida na idempotência do `POST /emails` (Task 8) — duas requisições concorrentes com o mesmo `Idempotency-Key` podiam gerar um 500 em vez de retornar o mesmo id. Corrigido (`INSERT ... ON CONFLICT DO NOTHING` com fallback de leitura).
- **Bug real:** conexões de Kafka/Redis/Postgres nunca eram fechadas ao encerrar o app (Tasks 6, 7) — vazamento de conexão em cada teste. Corrigido (hooks `onClose` no Fastify).
- **Gap de conformidade com a spec:** o consumer do Dispatch Worker (Task 10) não tinha proteção contra mensagem malformada travando a partição para sempre, nem contra reenvio duplicado de um mesmo email pela SES. Corrigido (DLQ + trava de deduplicação via Redis).
- **Risco de flakiness:** testes que sincronizavam com um `sleep` fixo em vez de esperar o consumer Kafka realmente entrar no grupo (Tasks 10, 11). Corrigido (espera pelo evento `GROUP_JOIN`).
- **Contradição:** as Restrições Globais diziam que testes deviam limpar o que criam, mas nenhum teste de fato limpava as linhas inseridas no Postgres (Tasks 6, 8, 11). Corrigido (`afterAll` agora deleta o que foi inserido).

## Restrições globais (valem para todas as tasks)

- Node.js ≥20, TypeScript ≥5.6, `"strict": true`.
- ESM only (`"type": "module"`), imports relativos com extensão `.js` explícita (exigência do `moduleResolution: NodeNext`).
- Gerenciador de pacotes é **pnpm** (`packageManager: "pnpm@9.12.0"`) — nunca usar comandos de npm/yarn.
- Cada serviço tem seu próprio schema Postgres; nenhum serviço lê tabelas de outro schema diretamente — comunicação entre serviços é só via eventos Kafka.
- Tópicos Kafka são sempre as constantes de `@ruguin/event-schemas` (`TOPICS.*`) — nunca strings literais soltas no código.
- Testes de integração rodam contra a stack `docker-compose` (Postgres/Redis/Kafka/LocalStack) já subida via `docker compose up -d` — não usamos Testcontainers neste plano.
