# Especificação de Produto — SaaS de Envio de Email Transacional

**Última atualização:** 2026-07-29
**Fontes:** `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`, `docs/superpowers/specs/2026-07-28-human-tickets-design.md`, `docs/superpowers/specs/2026-07-29-api-server-hardening-design.md`, `docs/superpowers/specs/2026-07-29-local-observability-stack-design.md`, `docs/tasks/EMAIL-1` a `EMAIL-6`.

Este documento consolida, num único lugar, os requisitos funcionais, não funcionais, contratos de eventos e endpoints do produto — tanto o que já tem trabalho fatiado em ticket quanto o que está desenhado na spec de arquitetura mas ainda não foi ticketado. Cada item é marcado como:

- **[Ticketado: EMAIL-N]** — já tem um ticket em `docs/tasks/` cobrindo a implementação.
- **[Planejado]** — faz parte da arquitetura-alvo aprovada, mas ainda não foi quebrado em ticket nem implementado.

## 1. Visão geral

Um SaaS de envio de email transacional (estilo Resend/Postmark), em Node.js + TypeScript, com arquitetura multi-tenant desde o início. O envio real é delegado à AWS SES — o produto foca em API, orquestração, templates, tracking e observabilidade de entrega, não em construir um MTA próprio.

Além do objetivo de produto, este projeto é deliberadamente um veículo de aprendizado de arquitetura de microsserviços orientada a eventos com Kafka — isso justifica um número de serviços maior do que o volume de envio esperado inicialmente exigiria.

**Fora de escopo (todo o produto):**

- Editor de campanhas de marketing, gestão de listas de contatos, agendamento de broadcasts em massa — sub-produto separado, a especificar depois, construído sobre esta base transacional.
- MTA/infraestrutura de envio própria — sempre via AWS SES.
- Anexos (attachments) e armazenamento em S3 — decisão em aberto, não detalhada ainda.
- Verificação de domínio (SPF/DKIM/DMARC) — decisão em aberto, o fluxo de UX fica para um plano de implementação futuro.

## 2. Arquitetura — serviços

| Serviço                  | Responsabilidade                                                                                                                                 | Status                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **API Service**          | Autenticação via API key, `POST /emails`, CRUD de templates/domínios/projetos/orgs, endpoints de leitura para o dashboard                        | [Ticketado: EMAIL-3, EMAIL-4] (auth + envio); CRUD de conta [Planejado] |
| **Dispatch Worker**      | Resolve template, rate limiting (Redis), chama `SendEmail` da SES, trata retry/backoff                                                           | [Ticketado: EMAIL-5]                                                    |
| **SES Webhook Ingestor** | Recebe notificações da SES via Amazon EventBridge (delivery/bounce/complaint), normaliza o payload, mantém a correlação `sesMessageId → emailId` | [Planejado]                                                             |
| **Tracking Service**     | Endpoints públicos de pixel de abertura e redirecionamento de clique, resposta em milissegundos                                                  | [Planejado]                                                             |
| **Webhook Notifier**     | Entrega webhooks assinados (HMAC-SHA256) para os endpoints configurados pelos clientes, com retry/backoff                                        | [Planejado]                                                             |
| **Read-Model Updater**   | Consome todos os tópicos e mantém as tabelas de leitura no Postgres que alimentam o dashboard                                                    | [Planejado]                                                             |

> **Nota de implementação:** a spec original especifica Fastify como framework HTTP do API Service. O código real em `apps/core-server` usa **NestJS** sobre o adapter `@nestjs/platform-fastify`, mantendo o alinhamento com a spec. Os imports relativos em `src/` são escritos sem extensão; um passo de pós-build (`scripts/fix-esm-imports.mjs`) reescreve o `dist/` compilado para incluir `.js`, que é o que o Node exige em ESM puro em runtime.

Nenhum dos seis serviços tem nome de diretório fixado no monorepo ainda além de `apps/core-server`; `apps/dispatch-worker` e os demais nascem quando os tickets/planejamento correspondentes forem abertos.

## 3. Requisitos funcionais

### 3.1 Autenticação e multi-tenancy — [Ticketado: EMAIL-3]

- Toda requisição a uma rota protegida é autenticada por uma API key enviada no cabeçalho de autorização.
- A API key nunca é armazenada em texto puro — só o hash é persistido; a autenticação compara hashes.
- O resultado de uma autenticação bem-sucedida é cacheado (Redis) por poucos minutos — revogar uma chave não tem efeito instantâneo, só após o cache expirar.
- Hierarquia de dados: organização → projeto → (API keys, templates, emails). Cada projeto pertence a exatamente uma organização; templates e emails pertencem a exatamente um projeto.
- Nenhuma consulta pode retornar ou aceitar dados de um projeto diferente do dono da API key usada na requisição (isolamento multi-tenant obrigatório, verificado a cada acesso, não só na autenticação).
- Requisição sem cabeçalho de autenticação, ou com API key desconhecida/revogada, retorna `401`.

### 3.2 Envio de email — [Ticketado: EMAIL-4]

- Endpoint que aceita um pedido de envio referenciando um template salvo (+ variáveis) OU assunto/HTML direto.
- Suporta idempotência via cabeçalho opcional `Idempotency-Key`: reenvios com a mesma chave retornam o mesmo identificador de email, sem duplicar o registro nem publicar um segundo evento — garantia sustentada mesmo sob requisições concorrentes (via constraint no banco, não checagem em memória).
- Renderização de template: variáveis no formato `{{nome}}` são substituídas pelos valores informados; se uma variável referenciada no template não for informada, o pedido falha explicitamente (nunca envia com `{{nome}}` literal).
- Um `templateId` só pode ser usado se pertencer ao mesmo projeto da API key da requisição.
- O endpoint nunca chama a SES diretamente — só valida, persiste e publica o evento `email.send.requested`. O envio de fato é assíncrono (Dispatch Worker).

### 3.3 Processamento assíncrono e envio via SES — [Ticketado: EMAIL-5]

- Worker em background consumindo `email.send.requested`.
- Respeita um limite de taxa compartilhado entre todas as instâncias do worker (Redis como fonte de tempo compartilhada, não o relógio de cada máquina).
- Chama `SendEmail` da AWS SES (ou LocalStack em dev/teste).
- Em sucesso, publica `email.status.updated` com status `sent` + `sesMessageId`; em falha, publica `status=failed` (sem retry automático da própria falha da SES — fica para hardening futuro).
- Mensagens malformadas/corrompidas vão para a DLQ de `email.send.requested`, sem travar o processamento das mensagens seguintes.
- Proteção contra reenvio duplicado da mesma mensagem Kafka (entrega "pelo menos uma vez").

### 3.4 Recepção de status de entrega — [Planejado]

- Endpoint HTTP que recebe notificações da SES via Amazon EventBridge (delivered, bounce, complaint) — não SNS; ver `docs/superpowers/specs/2026-08-04-ses-webhook-ingestor-design.md`.
- Mantém uma tabela de correlação `sesMessageId → emailId`, populada a partir de `email.status.updated` (`status=sent`) — a notificação da SES só carrega o `sesMessageId`, nunca o `emailId` interno.
- Normaliza o payload e publica `email.status.updated` com o status correspondente (`delivered`/`bounced`/`complained`, com `bounceType` quando aplicável).
- Base para a regra de supressão automática de endereços (ver NFR de confiabilidade).

### 3.5 Rastreamento de engajamento — [Planejado]

- Endpoint público de pixel de abertura (imagem 1x1) e endpoint de redirecionamento de clique.
- Ambos publicam em `email.engagement` antes de servir a imagem/redirecionar — não podem bloquear a resposta ao usuário.

### 3.6 Entrega de webhooks para clientes — [Planejado]

- Consome `email.status.updated` e `email.engagement`.
- Entrega um `POST` assinado (HMAC-SHA256) para a URL de webhook configurada pelo projeto do cliente.
- Retry com backoff exponencial e jitter, ~5 tentativas ao longo de ~1 hora; esgotadas as tentativas, marca a entrega como falha, reenviável manualmente pelo dashboard.

### 3.7 Read-model e dashboard — [Planejado]

- Consome todos os tópicos Kafka e mantém as tabelas de leitura no Postgres (status do email, histórico de engajamento) que alimentam o dashboard.
- O dashboard consulta o API Service, que por sua vez lê as tabelas de leitura mantidas por este serviço — nenhum acesso direto de outro serviço a essas tabelas.
- **Nota:** sem este serviço, o registro de um email na tabela `emails` permanece com `status=queued` mesmo após o envio ser concluído — hoje (EMAIL-6) a prova de sucesso do pipeline é o evento Kafka, não uma coluna do banco.

### 3.8 CRUD de gestão de conta — [Planejado]

- API para criar/gerenciar organizações, projetos, API keys, templates e domínios verificados — hoje esses dados só existem via seed manual/script (usado pelos testes de EMAIL-3/4/6).
- Inclui emissão e revogação de API keys.

### 3.9 Supressão automática de endereços — [Planejado]

- Bounce definitivo (hard bounce) ou complaint marca o endereço de destino como suprimido.
- Envios futuros para um endereço suprimido são bloqueados no API Service antes de chegar à SES.

## 4. Requisitos não funcionais

### 4.1 Segurança

- API keys nunca armazenadas em texto puro (hash apenas). — [Ticketado: EMAIL-3]
- Webhooks de saída assinados com HMAC-SHA256, permitindo ao cliente validar autenticidade. — [Planejado]
- Isolamento multi-tenant obrigatório em toda consulta que toca dado de organização/projeto. — [Ticketado: EMAIL-3, EMAIL-4]
- Nenhuma credencial real de nuvem é necessária para desenvolver ou rodar testes localmente (LocalStack substitui AWS). — [Ticketado: EMAIL-1]

### 4.2 Confiabilidade e consistência

- Semântica de entrega Kafka é _at-least-once_ — todo consumidor deve ser seguro contra reprocessamento do mesmo evento (deduplicação por identificador do evento/email). — [Ticketado: EMAIL-5]
- Todo tópico principal tem uma DLQ correspondente; nenhum evento é descartado silenciosamente. — [Ticketado: EMAIL-2, EMAIL-5]
- Idempotência de envio garantida por constraint de banco, não por checagem em memória. — [Ticketado: EMAIL-4]
- Rate limiting da conta SES é compartilhado entre instâncias do worker via Redis, nunca em memória local do processo. — [Ticketado: EMAIL-5]
- Cada serviço é dono exclusivo do seu schema Postgres — nenhum serviço lê/escreve tabelas de outro serviço diretamente; toda comunicação entre serviços é via evento Kafka. — [Ticketado: EMAIL-3]

### 4.3 Performance

- Tracking Service (pixel/redirecionamento) precisa responder em milissegundos — é chamado no caminho crítico da experiência do destinatário do email. — [Planejado]
- Autenticação de API key cacheada em Redis para evitar consulta ao Postgres a cada requisição. — [Ticketado: EMAIL-3]

### 4.4 Observabilidade e operabilidade

- Logging estruturado via Pino (`nestjs-pino`), nível configurável por `LOG_LEVEL`, redação automática de headers sensíveis (ex: `Authorization`), pretty-print apenas fora de produção. — [Ticketado, api-server-hardening]
- Tracing distribuído via OpenTelemetry (auto-instrumentation), exportando para um OTel Collector local (`localhost:4317`/`4318`), configurável via `OTEL_EXPORTER_OTLP_ENDPOINT`. — [Ticketado, api-server-hardening]
- Health check via `@nestjs/terminus` em `GET /health` — hoje só confirma que o processo HTTP está de pé; checks de Postgres/Redis/Kafka entram quando esses clients existirem no serviço. — [Ticketado: EMAIL-3 / api-server-hardening]
- Stack de observabilidade local (Grafana + Prometheus + Tempo + Loki + OTel Collector + exporters de Postgres/Kafka/host/containers), toda provisionada como código — cobre infraestrutura hoje, pronta para receber telemetria das aplicações. Escopo estritamente local/dev, não produção. — [Implementado, `infrastructure/local/`]
- DLQs de cada tópico visíveis no dashboard para inspeção e reprocessamento manual. — [Planejado]

### 4.5 Qualidade e manutenibilidade

- TypeScript em modo estrito em todos os serviços; módulos ES (não CommonJS). — [Ticketado: EMAIL-1]
- Monorepo pnpm workspaces + Turborepo; cada serviço em `apps/<nome>`, código compartilhado em `packages/`. — [Ticketado: EMAIL-1]
- Contrato de eventos centralizado num pacote compartilhado (`packages/event-schemas`, validado via Zod) — mudança que quebra o contrato quebra o build de compilação, não o comportamento em produção. — [Ticketado: EMAIL-2]
- Testes em camadas: unitários (Vitest, lógica pura), integração por serviço (contra Kafka/Postgres/Redis reais), contrato de eventos, ponta a ponta (docker-compose + LocalStack), carga/rate-limit. — [Ticketado: EMAIL-2 a EMAIL-6]
- Preferir `Either`/`Success`/`Failure` de `@ruguin/utils` para falhas esperadas/de domínio, em vez de exceptions ou result types ad-hoc. — [Convenção, `CLAUDE.md`]

### 4.6 Portabilidade e ambiente local

- Toda a infraestrutura (Postgres, cache compatível com Redis via Valkey, Kafka em modo KRaft com broker único, LocalStack para SES) sobe com um único comando Docker Compose, sem credenciais reais de nuvem. — [Ticketado/Implementado: EMAIL-1, `infrastructure/local/`]
- Node.js 20+ exigido em toda a stack.

## 5. Eventos do message broker (Kafka)

Todo timestamp em payload de evento é ISO 8601 UTC (`Z`). Cada tópico abaixo tem uma DLQ correspondente (`<tópico>.dlq`).

| Tópico                     | Produtor(es)                          | Consumidor(es)                       | Payload (campos principais)                                                                                                                                          | Status                                                                                                         |
| -------------------------- | ------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `email.send.requested`     | API Service (`POST /emails`)          | Dispatch Worker                      | id do email, id da org, id do projeto, remetente, destinatário, assunto e HTML já resolvidos (variáveis de template substituídas), chave de idempotência opcional    | [Ticketado: EMAIL-2 (contrato), EMAIL-4 (produtor), EMAIL-5 (consumidor)]                                      |
| `email.status.updated`     | Dispatch Worker, SES Webhook Ingestor | Webhook Notifier, Read-Model Updater | id do email, novo status (`sent`\|`delivered`\|`bounced`\|`complained`\|`failed`), id da mensagem do provedor (`sesMessageId`) ou mensagem de erro, quando aplicável | Produtor Dispatch Worker [Ticketado: EMAIL-5]; produtor SES Webhook Ingestor, e ambos consumidores [Planejado] |
| `email.engagement`         | Tracking Service                      | Webhook Notifier, Read-Model Updater | id do email, tipo de evento (abertura\|clique), timestamp, metadados de clique (URL de destino, quando aplicável)                                                    | Contrato definido [Ticketado: EMAIL-2]; produtor e consumidores [Planejado]                                    |
| `email.send.requested.dlq` | Kafka (redirecionamento automático)   | — (inspeção/reprocessamento manual)  | mensagem original + motivo da falha                                                                                                                                  | [Ticketado: EMAIL-2 (contrato), EMAIL-5 (uso)]                                                                 |
| `email.status.updated.dlq` | Kafka (redirecionamento automático)   | — (inspeção/reprocessamento manual)  | mensagem original + motivo da falha                                                                                                                                  | [Ticketado: EMAIL-2 (contrato)]; uso real [Planejado]                                                          |
| `email.engagement.dlq`     | Kafka (redirecionamento automático)   | — (inspeção/reprocessamento manual)  | mensagem original + motivo da falha                                                                                                                                  | [Ticketado: EMAIL-2 (contrato)]; uso real [Planejado]                                                          |

## 6. Endpoints necessários

| Método                         | Path                           | Serviço              | Auth                                                            | Request                                                                                             | Response                                                                                                                                              | Status                                                               |
| ------------------------------ | ------------------------------ | -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `GET`                          | `/health`                      | API Service          | Nenhuma                                                         | —                                                                                                   | `200` com corpo simples indicando o processo de pé                                                                                                    | [Ticketado: EMAIL-3 / api-server-hardening]                          |
| `POST`                         | `/emails`                      | API Service          | API key                                                         | `from`, `to`, e (`templateId`+`variables`) OU (`subject`+`html`); header opcional `Idempotency-Key` | `202` com `id` do email e `status=queued`; `400` (faltando template/subject+html); `404` (`templateId` inexistente ou de outro projeto); `401` (auth) | [Ticketado: EMAIL-4]                                                 |
| `GET`                          | `/emails/:id`                  | API Service          | API key                                                         | —                                                                                                   | Status atual do email e histórico de eventos (alimentado pelo Read-Model Updater)                                                                     | [Planejado]                                                          |
| `POST`                         | `/orgs`                        | API Service          | — (bootstrap) ou API key admin                                  | Dados da organização                                                                                | Organização criada                                                                                                                                    | [Planejado]                                                          |
| `POST`                         | `/projects`                    | API Service          | API key                                                         | Dados do projeto                                                                                    | Projeto criado                                                                                                                                        | [Planejado]                                                          |
| `POST`                         | `/api-keys`                    | API Service          | API key                                                         | —                                                                                                   | Nova API key emitida (retornada em texto puro só nesta resposta)                                                                                      | [Planejado]                                                          |
| `DELETE`                       | `/api-keys/:id`                | API Service          | API key                                                         | —                                                                                                   | Revoga a chave                                                                                                                                        | [Planejado]                                                          |
| `POST` `/GET`/`PATCH`/`DELETE` | `/templates`, `/templates/:id` | API Service          | API key                                                         | CRUD de template (assunto, corpo HTML com placeholders `{{var}}`)                                   | Template criado/consultado/atualizado/removido                                                                                                        | [Planejado]                                                          |
| `POST` `/GET`                  | `/domains`, `/domains/:id`     | API Service          | API key                                                         | Domínio a verificar; status de verificação SPF/DKIM/DMARC                                           | Domínio criado/consultado                                                                                                                             | [Planejado] (depende da decisão em aberto de verificação de domínio) |
| `POST`                         | `/webhooks/ses`                | SES Webhook Ingestor | Segredo compartilhado (header, via EventBridge API Destination) | Notificação da SES via EventBridge (delivery/bounce/complaint)                                      | `200` (ack)                                                                                                                                           | [Planejado]                                                          |
| `GET`                          | `/track/open/:emailId.png`     | Tracking Service     | Nenhuma (pixel público)                                         | —                                                                                                   | Imagem 1x1 (resposta em milissegundos)                                                                                                                | [Planejado]                                                          |
| `GET`                          | `/track/click/:emailId`        | Tracking Service     | Nenhuma (link público)                                          | `?url=` destino original                                                                            | `302` redirecionando para a URL de destino                                                                                                            | [Planejado]                                                          |
| `POST` `/GET`                  | `/webhook-endpoints`           | API Service          | API key                                                         | URL de destino do webhook do cliente                                                                | Endpoint de webhook configurado                                                                                                                       | [Planejado]                                                          |

## 7. Referências

- Spec de arquitetura: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`
- Formato dos tickets: `docs/superpowers/specs/2026-07-28-human-tickets-design.md`
- Hardening do API Service: `docs/superpowers/specs/2026-07-29-api-server-hardening-design.md`
- Stack de observabilidade local: `docs/superpowers/specs/2026-07-29-local-observability-stack-design.md`
- Tickets: `docs/tasks/EMAIL-1-setup-monorepo-infra.md` a `docs/tasks/EMAIL-6-teste-e2e-pipeline-envio.md`
