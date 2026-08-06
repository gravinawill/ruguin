# Core Server — Autenticação multi-tenant e envio de email (EMAIL-3 + EMAIL-4) — Design

**Data:** 2026-08-04
**Escopo:** `apps/core-server` — cinco módulos novos: `organization`, `project`, `api-key`,
`template`, `email`.

## Contexto

`apps/dispatch-worker` está completo (event-schemas, `@ruguin/message-broker`, consumers,
envio via SES, retry/DLQ) e `apps/core-server` já tem toda a infraestrutura compartilhada — outbox
transacional, `TransactionManager`, `@ruguin/cache`, `@ruguin/message-broker`, health, tracing — mas
nenhum módulo de negócio. Não existe ainda nada que publique em `email.send.requested` de verdade: o
pipeline ponta a ponta descrito na spec original
(`docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`) tem o Dispatch Worker pronto
esperando do lado errado.

Os tickets técnicos `docs/tasks/EMAIL-3-api-service-auth-multi-tenant.md` e
`docs/tasks/EMAIL-4-endpoint-envio-email.md` definem a regra de negócio desta fatia. Ambos foram
escritos antes da arquitetura modular do core-server existir (`apps/core-server/CLAUDE.md`, que
define oito módulos de negócio esperados e diz explicitamente que o primeiro a ser construído "vira
o precedente que os outros sete copiam") — este design segue essa arquitetura, não a stack literal
sugerida nos tickets (Drizzle/ioredis/KafkaJS crus), reaproveitando os pacotes internos que já
existem para esse fim (`@ruguin/cache`, `@ruguin/message-broker`, Prisma 7).

## Objetivo

Definir: (1) os cinco módulos de negócio e o contrato entre eles; (2) o modelo de dados; (3) o
mecanismo de autenticação por API key; (4) o fluxo idempotente de `POST /emails`; (5) o mapeamento de
erro de domínio para HTTP, inexistente hoje no core-server; (6) o mecanismo de seed para
desenvolvimento e testes.

Não cobre: CRUD HTTP de organização/projeto/API key/template (dados só existem via seed — ver
"Fora de escopo" da spec original), verificação de domínio de envio, anexos, tracking de
abertura/clique, nem sincronização de status via `email.status.updated` (read-model futuro).

## Decisões

### 1. Cinco módulos separados por agregado, não um módulo de tenancy único

```
organization  (dados + OrganizationLookupProvider)
      ↑
   project    (dados + ProjectLookupProvider; FK organizationId)
      ↑
   api-key    (hash + cache + ApiKeyAuthGuard; FK projectId)
      ↑                              ↑
   email  ───────────────────────  template  (dados + TemplateLookupProvider + render puro; FK projectId)
```

`organization` e `project` não expõem use-case além do necessário para o próprio `LookupProvider` —
são repositório + contract, seguindo a regra já documentada em `CLAUDE.md` ("ler dado de outro
módulo passa pelo próprio contract"). Isso evita que `api-key` importe o repositório Prisma de
`project` diretamente, e mantém a costura testável (mock do contract, sem banco) que o resto do app
já segue.

Alternativa recusada: um módulo único `tenancy` agrupando organization+project+api-key, já que os
três hoje só existem via seed. Rejeitada porque contraria o próprio `CLAUDE.md`, que já lista os
oito módulos como unidades separadas — e porque este é declaradamente o módulo-precedente: aceitar o
atalho aqui define o padrão errado para os sete módulos seguintes (incluindo quando
organization/project ganharem CRUD HTTP próprio, fora de escopo aqui mas previsto).

### 2. Modelo de dados — um `.prisma` por módulo, mesma convenção do `outbox.prisma`

```prisma
// prisma/schema/organization.prisma
model Organization {
  id        String   @id @default(uuid(7))
  name      String
  createdAt DateTime @default(now())

  @@map("organizations")
}

// prisma/schema/project.prisma
model Project {
  id             String   @id @default(uuid(7))
  organizationId String
  name           String
  createdAt      DateTime @default(now())

  @@index([organizationId])
  @@map("projects")
}

// prisma/schema/api-key.prisma
model ApiKey {
  id         String    @id @default(uuid(7))
  projectId  String
  hashedKey  String    @unique
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())

  @@index([projectId])
  @@map("api_keys")
}

// prisma/schema/template.prisma
model Template {
  id        String   @id @default(uuid(7))
  projectId String
  name      String
  subject   String
  html      String
  createdAt DateTime @default(now())

  @@index([projectId])
  @@map("templates")
}

// prisma/schema/email.prisma
model Email {
  id             String      @id @default(uuid(7))
  projectId      String
  templateId     String?
  idempotencyKey String?
  from           String
  to             String
  subject        String
  html           String
  status         EmailStatus @default(QUEUED)
  createdAt      DateTime    @default(now())

  @@index([projectId])
  @@map("emails")
}

enum EmailStatus {
  QUEUED
}
```

A restrição `(projectId, idempotencyKey)` **não** entra como `@@unique` no DSL: precisa ser parcial
(`WHERE idempotency_key IS NOT NULL`), porque um request sem `Idempotency-Key` não participa da
dedup. O Prisma DSL não expressa índice parcial — mesma situação documentada em `outbox.prisma` para
o particionamento. A migration nasce via `prisma migrate dev` e é editada à mão para adicionar:

```sql
CREATE UNIQUE INDEX emails_project_idempotency_key_key
  ON core_server.emails (project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

### 3. Hash de API key: SHA-256, não bcrypt

A chave de API é um token de alta entropia gerado aleatoriamente (não uma senha escolhida por
humano), então um hash rápido e determinístico é apropriado — força bruta contra o espaço de chaves
já é inviável independente da velocidade do hash. bcrypt existe para tornar lenta a tentativa de
adivinhar senhas de baixa entropia; aplicado aqui, só adicionaria latência a toda requisição
autenticada sem ganho de segurança correspondente.

O resultado de uma autenticação bem-sucedida fica em cache via `GetOrSetCacheProvider` de
`@ruguin/cache` (mesmo pacote já usado no resto do app), chave `api-key:{hashedKey}`, valor
`{ projectId, organizationId }`, TTL curto configurável por env (padrão sugerido: 5 minutos) — miss
consulta `api_keys` por `hashedKey` com `revokedAt IS NULL`, e o resultado (achado ou não) é o que
populam o cache. Revogar uma chave não tem efeito instantâneo, só depois que o cache daquela chave
expirar — comportamento aceito explicitamente pelo ticket EMAIL-3.

### 4. `ApiKeyAuthGuard` — header `Authorization: Bearer <chave>`

Guard do NestJS no módulo `api-key`, aplicado ao controller de `email` (e a qualquer controller
futuro que precise de auth) via `@UseGuards(ApiKeyAuthGuard)`. Resolve o header, calcula o hash,
consulta cache→banco (decisão 3), e anexa `{ projectId, organizationId }` ao request. Ausência do
header, chave desconhecida ou revogada → `401` antes de qualquer lógica de negócio rodar.

### 5. Renderização de template — função pura, sem dependência nova

Sintaxe `{{nome}}`, substituição de uma passada só, implementada como função pura em
`template/domain/` (sem I/O, sem framework — respeita a regra de `domain/` livre de dependência
externa). Variável referenciada no template e ausente no payload → falha explícita (`422`), nunca
HTML com `{{nome}}` literal.

Alternativa recusada: trazer uma lib de template (Handlebars, Mustache.js). Rejeitada por YAGNI — o
requisito é substituição posicional simples, sem lógica condicional nem loop; uma dependência nova
para isso é peso sem função.

### 6. Idempotência — índice parcial + `createIfNotExists`, nunca check-then-write

O ticket EMAIL-4 exige que a garantia venha do banco, não de uma checagem em memória antes de
gravar — duas requisições concorrentes com o mesmo `Idempotency-Key` não podem passar as duas pela
checagem antes de qualquer uma gravar. O repositório expõe:

```ts
interface EmailRepository {
  createIfNotExists(
    email: Email,
    tx: TransactionContext
  ): Promise<Either<CreateEmailError, { email: Email; created: boolean }>>
}
```

`created: false` significa que o índice parcial (decisão 2) rejeitou o insert e o repositório releu
a linha existente por `(projectId, idempotencyKey)` — comportamento equivalente ao já documentado em
`CLAUDE.md` ("repositórios traduzem erro de infraestrutura em erro de domínio"), só que aqui o
resultado da colisão é sucesso, não falha: o cliente que perdeu a corrida recebe o mesmo `id` do que
venceu.

Dentro do use case, publicar no outbox só acontece quando `created === true` — evita enfileirar
`email.send.requested` duas vezes para o mesmo pedido:

```ts
return this.transactionManager.execute(async (tx) => {
  const result = await this.emailRepository.createIfNotExists(email, tx)
  if (isFailure(result)) return result
  const { email: persisted, created } = result.value
  if (created) {
    const event = createEmailSendRequestedEvent({ ... })
    const enqueued = await this.outbox.enqueue(event, { topic: 'email.send.requested', key: persisted.projectId }, tx)
    if (isFailure(enqueued)) return enqueued
  }
  return success(persisted)
})
```

### 7. `BaseErrorExceptionFilter` — mapeamento `StatusError` → HTTP, inexistente hoje

Nenhum controller do core-server hoje precisa traduzir `Either` de falha em resposta HTTP (health
usa Terminus, outbox não tem superfície HTTP). Este design introduz um `@Catch(BaseError)` global em
`shared/infrastructure/http/`:

```ts
const STATUS_ERROR_TO_HTTP: Record<StatusError, number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500
}
```

Controllers convertem um `Either` de falha em `throw result.value` no limite da camada de
apresentação — não contraria a regra "throw é para bug" do `CLAUDE.md`, porque é o idioma do próprio
NestJS para a fronteira HTTP, e o filtro captura qualquer `BaseError`, não um tipo específico por
rota. Reutilizável pelos sete módulos futuros, não só por este.

### 8. Validação de request: Zod

`zod@4.4.3`, mesma versão já usada em `@ruguin/event-schemas` e `@ruguin/env` — não há
`class-validator`/`class-transformer` no core-server hoje, e introduzir uma segunda lib de validação
para um único endpoint não se paga. O schema Zod do corpo de `POST /emails` valida a união
`(templateId + variables) | (subject + html)` e vive em `email/application/controllers/dtos/`.

### 9. Seed de desenvolvimento e teste

`prisma.config.ts` ganha `migrations.seed` apontando para `prisma/seed.ts`, que cria uma
organização, um projeto e um template, e gera a API key com `crypto.randomBytes(32).toString('hex')`
— 32 bytes de entropia, hex por simplicidade de transporte (sem necessidade de um formato com prefixo
cosmético nesta fase, já que não existe CRUD para o cliente final gerar a própria chave). A chave
crua é impressa uma única vez no output do seed — não é recuperável depois, mesma garantia de "nunca
armazenada em texto puro" do banco. Rodado via `pnpm with-env pnpm --filter @ruguin/core-server
db:seed`, e reaproveitado pelo setup dos testes e2e (mesmo padrão de `vitest.setup.e2e.ts`, que já
força `DATABASE_URL` antes da suíte rodar).

## Fluxo de dados — `POST /emails`

1. `ApiKeyAuthGuard` resolve `projectId`/`organizationId` (decisão 3+4); ausência/invalidez → `401`.
2. DTO Zod valida o corpo (decisão 8); corpo inválido → `400`.
3. Se `templateId`: `TemplateLookupProvider.find(templateId, projectId)`; não encontrado ou de outro
   projeto → `404` (nunca vaza dado de outro projeto).
4. Renderização `{{var}}` (decisão 5); variável ausente → `422`.
5. `Email.create(...)` — modelo de domínio, `Either` (mesmo padrão de `ID.generate()`).
6. `createIfNotExists` + outbox na mesma transação (decisão 6).
7. Sucesso → `202 { id, status: 'queued' }`.

## Testes

- **Unit**: renderização de template (variável ausente, substituição simples), `Email.create`,
  cálculo de hash da API key, `SendEmailUseCase` com contracts mockados (guard, lookup providers,
  repositório, outbox).
- **Integration** (Postgres real): `createIfNotExists` sob concorrência — duas escritas simultâneas
  com o mesmo `(projectId, idempotencyKey)` resultam em uma linha só e os dois callers recebendo o
  mesmo `id`; `ApiKeyAuthGuard` contra banco real (chave válida, revogada, inexistente).
- **E2E** (app buildado): os quatro critérios de aceite do EMAIL-3 e os quatro do EMAIL-4, usando
  dados do seed (decisão 9) — incluindo o cenário de `404` com um `templateId` de outro projeto.

## Fora de escopo

- CRUD HTTP de organização/projeto/API key/template — dados só via seed nesta fase.
- Verificação de domínio de envio, anexos, tracking de abertura/clique.
- Sincronização de `status` do `Email` com `email.status.updated` (read-model updater) — a prova de
  sucesso usada aqui é o evento publicado no outbox, não uma coluna do banco atualizada depois.
- Rate limiting no API Service (existe hoje só no Dispatch Worker, via Redis).
- Rotação/expiração automática de API key — só criação via seed e revogação manual (`revokedAt`).

## Riscos

- **Índice parcial fora do DSL do Prisma.** Mesma classe de risco já documentada para o
  particionamento do outbox: uma migration futura gerada automaticamente pode não preservar o
  índice parcial se alguém regenerar o schema sem notar a edição manual.
- **TTL do cache de API key mascara revogação por alguns minutos.** Aceito explicitamente pelo
  ticket EMAIL-3, mas vale registrar como comportamento deliberado, não descuido, para não ser
  "corrigido" sem essa memória depois.
- **`BaseErrorExceptionFilter` é peça nova compartilhada.** Por ser o primeiro uso, um erro de
  mapeamento aqui (`StatusError` errado para um `BaseError` novo) silenciosamente vira `500` em vez
  do código correto — mitigado pelos testes e2e cobrindo os quatro códigos de erro esperados
  (`400`/`401`/`404`/`422`).
