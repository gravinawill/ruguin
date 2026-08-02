# Guia de Nomenclatura DDD

**Escopo:** convenções de nome para apps, packages, bounded contexts, tópicos Kafka e schemas de banco usados no monorepo, para que os cinco serviços ainda não criados (ver `docs/product-spec.md` §2) nasçam consistentes com o que já existe (`apps/core-server`).

## 1. Apps (`apps/<nome>`)

- Nome em kebab-case, um app por **responsabilidade operacional distinta** (throughput, latência ou padrão de falha diferente dos demais) — nunca por tipo de entidade. É a mesma régua usada em `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md` §Serviços para separar os seis serviços do produto.
- Um app = um dono exclusivo de schema Postgres = uma unidade de deploy. Nenhum app lê tabela de outro diretamente; toda comunicação entre apps é via evento Kafka.
- O nome do app é o mesmo nome usado no schema Postgres (§6) e no `module` gravado nas linhas da outbox (§5).

## 2. Packages (`packages/<nome>`)

- Nome em kebab-case, código compartilhado entre apps, sem entrypoint HTTP nem consumer Kafka próprio.
- Existentes: `cache`, `ddd-kernel`, `env`, `utils`.
- Próximos, exigidos pelo roadmap de `docs/product-spec.md`:
  - `event-schemas` — schemas Zod + nomes de tópico dos três eventos do produto (`email.send.requested`, `email.status.updated`, `email.engagement`); única fonte de verdade, importada por todo produtor/consumidor (`docs/tasks/EMAIL-2-contrato-eventos-kafka.md`).
  - `message-broker` — adapter KafkaJS que implementa `MessageProducerPort` (`apps/core-server/src/shared/contracts/message-producer.port.ts`) e a contraparte de consumo usada pelos workers; hoje só existe o fake de teste (`shared/events/fake-message-producer.ts`).

## 3. Serviços → apps (mapeamento de `docs/product-spec.md` §2)

Cada serviço da tabela de arquitetura do produto tem um diretório proposto. Status **Decidido** = nome em uso, diretório já existe; **Proposto** = nome sugerido por este guia, diretório nasce quando o ticket/plano correspondente for aberto.

| #   | Serviço              | App                         | Status   |
| --- | -------------------- | --------------------------- | -------- |
| 3.1 | API Service          | `apps/core-server`          | Decidido |
| 3.2 | Dispatch Worker      | `apps/dispatch-worker`      | Proposto |
| 3.3 | SES Webhook Ingestor | `apps/ses-webhook-ingestor` | Proposto |
| 3.4 | Tracking Service     | `apps/tracking-service`     | Proposto |
| 3.5 | Webhook Notifier     | `apps/webhook-notifier`     | Proposto |
| 3.6 | Read Model           | `apps/read-model-updater`   | Proposto |

`core-server` é o único nome que não segue "um app por serviço" literalmente — o rename de `api-server` para `core-server` (`docs/superpowers/specs/2026-07-29-core-server-architecture-design.md` §1) já é o nome final da API Service; não existe um segundo nome "api-service" a caminho.

## 4. Bounded contexts dentro de um app

- Pasta `src/<bounded-context>/` no singular, um por contexto de domínio: `organization`, `project`, `api-key`, `template`, `domain`, `email` (hoje dentro de `core-server`, ver `docs/superpowers/specs/2026-07-29-core-server-architecture-design.md` §2).
- `health/`, `logger/`, `tracing/`, `shared/` não são bounded contexts — são infraestrutura técnica, ficam fora dessa regra.

## 5. Eventos Kafka

- Tópico: `<entidade>.<evento-no-passado>`, minúsculo, sem plural — `email.send.requested`, `email.status.updated`, `email.engagement`.
- Toda mensagem publicada carrega o envelope `{ eventId, name, payload }` (`OutboundMessage` em `message-producer.port.ts`); `name` identifica o tipo do evento, `payload` é o corpo validado por `event-schemas`.
- Dead-letter: mesmo nome do tópico principal + sufixo `.dlq` — nenhum evento é descartado silenciosamente (`docs/tasks/EMAIL-2-contrato-eventos-kafka.md`).

## 6. Schema Postgres

- Um schema por app, mesmo database local (`ruguin`), nome = nome do app com `-` trocado por `_`: `core_server`, `dispatch_worker`, `ses_webhook_ingestor`, `tracking_service`, `webhook_notifier`, `read_model_updater`.
- Aplicado via `?schema=<nome>` na `DATASOURCE_URL` do Prisma de cada app (`docs/superpowers/specs/2026-07-29-core-server-architecture-design.md` §1, item 4).
