# Core Server — Remetentes verificados (SenderIdentity) — Design

**Data:** 2026-08-05
**Escopo:** `apps/core-server` — um módulo novo (`sender-identities`); mudanças em `template` e
`email`; um campo novo no evento `email.send.requested` (consumido por `apps/dispatch-worker`).

## Contexto

Hoje `Email.from`/`Template` não têm nenhum vínculo com um remetente cadastrado — `POST /v1/emails`
aceita qualquer string de e-mail em `from`, para os dois caminhos de envio (`templateId+variables` ou
`subject+html` direto). Isso não dá ao cliente nenhuma garantia de que o endereço usado é
efetivamente dele, nem deixa o produto saber, sem reconstruir a partir de dados soltos, de qual
domínio/remetente cada envio saiu.

O `product-spec.md` já registra "Verificação de domínio (SPF/DKIM/DMARC)" como decisão em aberto,
fora de escopo do produto por ora. Este design **não** implementa isso — implementa um registro mais
simples de **remetentes individuais**, verificados via o mecanismo nativo de identidade de e-mail da
própria AWS SES (que já é o serviço de envio real do produto), sem construir verificação de domínio
própria.

Durante o brainstorm, três pedidos que pareciam uma coisa só se separaram em subsistemas
independentes — só o primeiro é coberto aqui:

1. **Remetentes verificados** (este design).
2. **React Email para templates** — muda como `Template.html` é gerado; spec própria, futura.
3. **Envio agendado** (sorted set no cache) — mexe em `Email`/outbox/dispatch-worker por um motivo
   totalmente diferente; spec própria, futura.

## Objetivo

Definir: (1) o modelo `SenderIdentity` e como ele se liga a `Template`/`Email`; (2) o fluxo de
cadastro e verificação via SES; (3) como o envio passa a exigir um remetente verificado; (4) cache do
lookup de remetente no caminho de envio; (5) o ajuste (pequeno) no payload do Kafka e no
`dispatch-worker` para o nome de exibição chegar até a SES.

Não cobre: verificação de domínio (SPF/DKIM/DMARC), CRUD HTTP de `Template` (continua só via seed,
como hoje), React Email, envio agendado, revogação/exclusão de `SenderIdentity`.

## Decisões

### 1. Modelo de dados

```prisma
// prisma/schema/sender-identity.prisma
model SenderIdentity {
  id         String    @id @default(uuid(7))
  projectId  String
  name       String
  email      String    @unique
  verifiedAt DateTime?
  createdAt  DateTime  @default(now())

  @@index([projectId])
  @@map("sender_identities")
}
```

`email` é `@unique` **globalmente**, não por projeto — decisão 6 explica o porquê. `verifiedAt`
segue o mesmo padrão nullable-timestamp já usado em `ApiKey.revokedAt`. Domínio (`gravina.dev`) não
vira coluna: é derivado de `email.split('@')[1]` sob demanda, evitando um campo que pode divergir do
valor real.

`Template` ganha uma coluna nova:

```prisma
model Template {
  // ...campos existentes
  senderIdentityId String
  // ...
  @@index([senderIdentityId])
}
```

É o remetente padrão/sugerido daquele template — **sem** validação cruzada contra o que de fato é
usado no envio (decisão 4 explica: o envio nem recebe mais um remetente na requisição).

`Email` ganha:

```prisma
model Email {
  // ...campos existentes
  senderIdentityId String
  templateId       String   // deixa de ser String? — todo envio passa por template agora (decisão 4)
}
```

`from` continua existindo e guardando o endereço resolvido no momento do envio — é o snapshot de
auditoria (o que foi de fato enviado), independente do `SenderIdentity` mudar depois. `senderIdentityId`
é a referência para join/consulta.

### 2. Verificação via API nativa da SES, não um fluxo de confirmação próprio

Em vez de core-server enviar seu próprio e-mail de confirmação (o que exigiria um remetente já
verificado para mandar um e-mail sobre verificar outro remetente — problema de ovo-e-galinha), o
cadastro chama `SESv2Client.CreateEmailIdentityCommand({ EmailIdentity: email })`. Para uma identidade
do tipo endereço de e-mail (não domínio), a própria AWS manda a confirmação e cuida de link/expiração
— o produto só consulta o resultado depois.

Isso entra por um contract novo, para manter a AWS fora de `domain/`:

```ts
// sender-identities/domain/contracts/providers/ses-identity.provider.ts
export interface SesIdentityProvider {
  createIdentity(input: { email: string }): Promise<Either<CreateSesIdentityError, void>>
  getVerificationStatus(input: { email: string }): Promise<Either<CheckSesIdentityError, { verified: boolean }>>
}
```

Implementação real em `infrastructure/aws/ses-identity.provider.ts`, usando `@aws-sdk/client-sesv2`
(dependência nova — dispatch-worker usa `@aws-sdk/client-ses`, a v1, só para `SendEmailCommand`; a
gestão de identidade é uma API distinta).

### 3. Sincronização por polling, não webhook

Um job `@Interval`, mesmo padrão do `OutboxPartitionMaintenanceService` que já existe em
`shared/infrastructure/outbox/`: a cada `SENDER_IDENTITY_SYNC_INTERVAL_MS` (novo campo em
`coreServerENV`, default 60000), busca toda `SenderIdentity` com `verifiedAt IS NULL`, chama
`GetVerificationStatus` para cada uma, grava `verifiedAt = now()` quando a SES confirmar, e invalida o
cache daquela identidade (decisão 5).

Alternativa recusada: notificação via SNS (a SES publica mudança de status de identidade num
tópico). Mais rápida, mas amarra este design a um serviço (`ses-webhook-ingestor`) que ainda não
existe — hoje é só "[Planejado]" no product-spec, sem endpoint, sem consumer. Polling entrega o
mesmo resultado funcional sem nova infraestrutura, com o custo aceito de até
`SENDER_IDENTITY_SYNC_INTERVAL_MS` de atraso entre a confirmação real e o sistema saber disso.

### 4. `POST /v1/emails` minimalista — remove o envio direto sem template

**Mudança que quebra compatibilidade com o que o EMAIL-4 já entrega hoje.** O corpo de
`POST /v1/emails` deixa de ser uma união de dois formatos e vira um único formato:

```ts
{ to: string; templateId: string; variables: Record<string, string> }
```

Não existe mais `from` na requisição (nem como string livre, nem como `senderIdentityId`) e não
existe mais o caminho `subject`+`html` direto. O remetente é resolvido **sempre** a partir de
`Template.senderIdentityId` — automático, como pedido originalmente.

Isso só é sustentável porque `templateId` passa a ser obrigatório em todo envio; sem essa decisão,
o caminho direto ficaria sem nenhuma forma de indicar remetente (motivo pelo qual a ideia de um
"remetente padrão do projeto" foi cogitada e descartada durante o brainstorm — deixou de ser
necessária assim que o caminho direto foi removido).

### 5. Cache do lookup de remetente no envio

Contract de módulo novo, seguindo a regra já em `apps/core-server/CLAUDE.md` ("cache consumido por
um use case passa por um contract do módulo"):

```ts
// sender-identities/domain/contracts/sender-identity-cache.provider.ts
export interface SenderIdentityCacheProvider {
  getVerified(input: { senderIdentityId: string }): Promise<Either<BaseError, SenderIdentity | null>>
  invalidate(input: { senderIdentityId: string }): Promise<void>
}
```

Implementação sobre `GET_OR_SET_CACHE_PROVIDER` (`@ruguin/cache`), namespace `'core-server-sender-identity'`
— hífen, não `:` (o `KeyBuilder` do pacote rejeita `:`; ficou documentado do jeito difícil nesta
mesma sessão, no `ApiKeyAuthGuard`). TTL configurável (`SENDER_IDENTITY_CACHE_TTL_IN_SECONDS`, mesmo
padrão de `API_KEY_CACHE_TTL_IN_SECONDS`). O job de sincronização (decisão 3) invalida a entrada assim
que grava `verifiedAt`, para o próximo envio já enxergar o remetente verificado sem esperar o TTL.

### 6. `email` único globalmente, não por projeto

A verificação na SES é por **conta AWS**, não por projeto/tenant nosso — se dois projetos diferentes
cadastrassem o mesmo endereço, o segundo "herdaria" a verificação feita pelo dono real do endereço
assim que ele confirmasse, sem nunca ter provado posse dele mesmo. `@unique` em `email` (não
`@@unique([projectId, email])`) faz o segundo cadastro falhar com `409` antes desse cenário existir.

### 7. `fromName` no payload do Kafka — único toque fora do core-server

Para o e-mail sair como `"Will Gravina <will@gravina.dev>"` (não só o endereço cru),
`EmailSendRequestedPayloadSchema` (`@ruguin/event-schemas`) ganha um campo `fromName` opcional, e
`SesEmailSender.send()` em `dispatch-worker` monta:

```ts
Source: input.fromName !== undefined ? `${input.fromName} <${input.from}>` : input.from
```

Nenhuma outra parte do dispatch-worker muda — `Source` já era `input.from` por mensagem (não um
valor fixo), então o resto do pipeline (consumer, retry, DLQ) não sabe nem precisa saber que o
remetente agora vem de um `SenderIdentity`.

### 8. Split de `awsENV` em `awsENV` + `sesENV`

`packages/env/src/packages/aws.environment.ts` hoje mistura credenciais genéricas da AWS
(`AWS_REGION`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) com campos específicos
de **envio** (`SES_FROM_ADDRESS`, `SES_SEND_RATE_LIMIT_PER_SECOND`) que só o dispatch-worker usa.
Como core-server agora também fala com a SES (identidade, não envio), estender `awsENV` inteiro o
obrigaria a ter `SES_FROM_ADDRESS` configurado sem nunca usá-lo. Move os dois campos de envio para um
`sesENV` novo; `coreServerENV` estende só `awsENV`, `dispatchWorkerENV` estende os dois.

### 9. Seed

`prisma/seed.ts` passa a criar também um `SenderIdentity` — escrito direto no Postgres já com
`verifiedAt` preenchido (mesmo padrão já usado para `ApiKey.hashedKey`: grava o resultado final, não
simula o fluxo real). O `Template` semeado referencia esse `senderIdentityId`. Isso mantém os testes
independentes de AWS/LocalStack real — dev/CI nunca precisa que a verificação de e-mail aconteça de
verdade para rodar a suíte.

## Fluxo de dados

**Cadastro — `POST /sender-identities { name, email }`** (atrás do mesmo `ApiKeyAuthGuard` de
`POST /v1/emails` — `projectId` vem do request, não do corpo):

1. Valida `name`/`email` não vazios e `email` em formato válido — inválido → `400`.
2. Cria a linha (`verifiedAt: null`) — `email` já cadastrado (de qualquer projeto) → `409`.
3. Chama `SesIdentityProvider.createIdentity` — falha na chamada → `500` (a linha já foi criada;
   o job de sincronização segue tentando `getVerificationStatus`, mas nunca vai confirmar se a SES
   nunca recebeu o `CreateEmailIdentity` — aceito como risco, ver seção Riscos).
4. Sucesso → `201` com o recurso (`verifiedAt: null`).

**`GET /sender-identities`** — lista os remetentes do projeto autenticado (necessário para escolher
qual `senderIdentityId` usar ao cadastrar um `Template`, já que não existe mais `from` na requisição
de envio).

**Envio — `POST /v1/emails { to, templateId, variables }`:**

1. `ApiKeyAuthGuard` resolve `projectId`/`organizationId` — sem mudança.
2. DTO Zod valida o corpo (formato único agora, decisão 4) — inválido → `400`.
3. `TemplateLookupProvider.find(templateId, projectId)` — não encontrado/de outro projeto → `404`.
4. `SenderIdentityCacheProvider.getVerified(template.senderIdentityId)` — não encontrado ou
   `verifiedAt === null` → `422` (`SenderIdentityNotVerifiedError`).
5. Renderização `{{var}}` (sem mudança) — variável ausente → `422`.
6. `Email.create(...)` com `senderIdentityId`, `from` resolvido, `templateId` obrigatório.
7. `createIfNotExists` + outbox na mesma transação (sem mudança na mecânica).
8. Sucesso → `202 { id, status: 'queued' }`.

## Testes

- **Unit**: `SenderIdentity.create` (nome/email vazio), `RegisterSenderIdentityUseCase` e
  `SyncSenderIdentityVerificationUseCase` com `SesIdentityProvider` mockado, `SenderIdentityCacheProvider`,
  `SendEmailUseCase` cobrindo o novo `422` de remetente não verificado.
- **Integration** (Postgres real): `@unique` em `email` rejeitando duplicata entre projetos
  diferentes; `SenderIdentitySyncService` contra Postgres real com o provider da SES mockado.
- **E2E**: cadastro de `SenderIdentity` contra SES via LocalStack (mesmo padrão que
  `dispatch-worker` já usa para `SendEmailCommand`); os critérios de aceite de `POST /v1/emails`
  reescritos para o formato minimalista, usando o `senderIdentityId` semeado (decisão 9);
  `404`/`422` para template inexistente/remetente não verificado.

## Fora de escopo

- Verificação de domínio (SPF/DKIM/DMARC) — decisão em aberto do product-spec, não antecipada aqui.
- CRUD HTTP de `Template` — continua só via seed.
- Revogação/exclusão de `SenderIdentity` (sem `DELETE`/`PATCH` nesta fase).
- React Email para templates e envio agendado — subsistemas próprios, specs futuras (ver Contexto).
- Migração de dados existentes — projeto ainda em pré-produção, sem necessidade de backfill para
  `Template.senderIdentityId`/`Email.templateId` passarem a ser obrigatórios.

## Riscos

- **`CreateEmailIdentity` falha depois da linha já criada.** O cadastro fica "preso" em
  `verifiedAt: null` para sempre, já que o job de sincronização só consulta status — nunca reenvia o
  `CreateEmailIdentity`. Sem endpoint de retry nesta fase; mitigação futura, não nesta spec.
- **TTL do cache mascara uma verificação recém-concluída por até `SENDER_IDENTITY_CACHE_TTL_IN_SECONDS`**,
  mesmo com a invalidação ativa do job de sync — se o job e uma leitura de cache colidirem na mesma
  janela. Mesma classe de risco já aceita para `API_KEY_CACHE_TTL_IN_SECONDS`.
- **Mudança de contrato quebra o EMAIL-4 já entregue.** `POST /v1/emails` perde o caminho
  `subject`+`html` direto — qualquer integração existente que dependa dele para de funcionar. Decisão
  deliberada (seção 4), não descuido.
- **LocalStack e SES v2 (identidade).** O dispatch-worker já testa `SendEmailCommand` (SES v1) contra
  LocalStack; não está confirmado que `CreateEmailIdentityCommand`/`GetEmailIdentityCommand` (SES v2)
  têm o mesmo nível de suporte na edição usada localmente — a ser confirmado na implementação.
