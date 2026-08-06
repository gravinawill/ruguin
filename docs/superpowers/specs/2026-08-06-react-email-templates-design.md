# Core Server — Templates via React Email — Design

**Data:** 2026-08-06
**Escopo:** um pacote novo (`packages/email-templates`); mudanças em `Template`/`Email`
(`apps/core-server`) e no payload do evento `email.send.requested` (consumido por
`apps/dispatch-worker`).

## Contexto

Hoje `Template.subject`/`Template.html` são strings gravadas à mão em `prisma/seed.ts` — não existe
CRUD HTTP de `Template` (decisão da spec de SenderIdentity, ainda de pé), então a única forma de
alterar um template é editar o literal do seed. Isso já era um dos três subsistemas identificados
como independentes durante o brainstorm da spec de SenderIdentity:

1. Remetentes verificados — implementado (`docs/superpowers/specs/2026-08-05-sender-identity-design.md`).
2. **Templates via React Email** (este design).
3. Envio agendado (sorted set no cache) — spec própria, futura.

Este design troca a *origem* do HTML/subject (de string escrita à mão para componente React
renderizado) sem tocar em *como* um template é armazenado ou lido no fluxo de envio — `Template`
continua sendo uma linha no Postgres com `subject`/`html` prontos, e `renderTemplate` continua
fazendo a mesma substituição `{{variavel}}` que já faz hoje.

## Objetivo

Definir: (1) onde os componentes React Email moram e como viram `{ subject, html, text }`; (2) como
o texto plano (multipart) é gerado e atravessa o pipeline de envio; (3) cache do lookup de `Template`
no caminho de envio, hoje inexistente.

Não cobre: CRUD HTTP de `Template` (continua só via seed), migração de templates existentes além do
único já semeado, verificação de domínio, envio agendado.

## Decisões

### 1. Compilação em build-time — banco continua sendo a fonte da verdade

Componentes React Email não são renderizados por destinatário, em request-time. Um script de build
os renderiza uma vez para `{ subject, html, text }`, e é esse resultado — já com os placeholders
`{{variavel}}` como texto literal — que `prisma/seed.ts` grava em `Template`. O restante do fluxo de
envio (`renderTemplate`, `SendEmailUseCase`, `Email`, outbox) não muda de forma nenhuma: continua
lendo três strings de uma linha e substituindo variável por destinatário, exatamente como faz hoje
para `subject`/`html`.

Alternativa recusada: renderizar o componente React de verdade a cada envio, com props reais do
destinatário. Permitiria lógica condicional real dentro do template, mas reescreveria o fluxo de
envio inteiro (deixa de ler uma coluna fixa) para um ganho que ninguém pediu — YAGNI.

### 2. Placeholders `{{variavel}}` como prop literal, não prop real

O componente recebe a string literal `'{{name}}'` como valor da prop no momento do build
(`<WelcomeEmail name="{{name}}" />`), não um valor de exemplo que seria substituído por um real. O
HTML/texto gerado ainda contém `{{name}}` como texto puro — é isso que `renderTemplate` substitui
depois, por destinatário, exatamente como já faz.

### 3. Pacote novo `packages/email-templates`

Mesmo padrão de build de todo o workspace (`tsdown` → `dist/`, consumido via `exports`; ver
`packages/env/package.json` como referência). Desacoplado do toolchain NestJS/SWC do `core-server` —
ganha de brinde o `react-email dev` (CLI do próprio ecossistema React Email), um servidor de preview
local que renderiza o componente ao vivo no navegador enquanto ele é editado.

```
packages/email-templates/
  src/
    templates/
      welcome.tsx        # componente WelcomeEmail + `export const subject = 'Hi {{name}}'`
    render.ts             # renderWelcomeEmailTemplate(): { subject, html, text }
    index.ts               # barrel
```

Dependências novas: `react`, `react-dom`, `@react-email/components` (primitivas de UI —
`Html`/`Body`/`Container`/`Text`/etc.), `@react-email/render` (`render()`, inclusive
`{ plainText: true }`), `react-email` (CLI de dev, devDependency).

Alternativa recusada: componentes dentro de `apps/core-server`. Mais perto do código que consome,
mas mistura o toolchain React (JSX, `react-email dev`) com o do NestJS/SWC do app, e não separa a
autoria visual (que pode envolver quem não mexe no resto do backend) da lógica de negócio.

### 4. Escopo desta migração: só o template `Welcome` já existente

Converte o único template hoje semeado (`subject: 'Hi {{name}}'`, `html: '<p>Hi {{name}}</p>'`) para
um componente React Email. Não introduz templates novos que ninguém pediu — mas a estrutura do
pacote (um arquivo de componente + uma função de render por template, agregados num barrel) já fica
pronta para o próximo template ser só mais um arquivo, sem redesenho.

### 5. Texto plano (multipart) como campo de primeira classe

O envio hoje manda só HTML (`SesEmailSender`'s `Body: { Html: {...} }`). `@react-email/render`
gera a versão em texto plano do mesmo componente sem trabalho extra de autoria
(`render(<WelcomeEmail .../>, { plainText: true })`). Em vez de derivar esse texto de forma
genérica a partir do HTML já renderizado (conversão HTML→texto perderia a fidelidade ao componente
original), `text` vira um terceiro campo persistido, espelhando exatamente `subject`/`html` em cada
camada:

```prisma
model Template {
  // ...campos existentes
  text String
}

model Email {
  // ...campos existentes
  text String
}
```

`renderTemplate` ganha um terceiro campo substituído; `EmailSendRequestedPayloadSchema`
(`@ruguin/event-schemas`) ganha `text: z.string().min(1)`; `SesEmailSender` monta
`Body: { Html: { Data: input.html }, Text: { Data: input.text } }`. A comparação de idempotência em
`EmailRepository.recoverFromUniqueViolation` (replay vs. conflito) passa a incluir `text` junto de
`from`/`to`/`subject`/`html` — um replay cujo `text` divergisse dos outros três seria, por definição,
um corpo diferente.

Alternativa recusada (Abordagem 2, cogitada e descartada no brainstorm): derivar `text` do `html`
já renderizado, em tempo de envio, sem persistir em `Template`/`Email`. Evita threading pelo
schema/pipeline, mas produz um texto de qualidade inferior (conversão HTML→texto genérica, não o
texto que o React Email geraria a partir do JSX original) — anularia o motivo de ter escolhido gerar
o texto pelo próprio React Email.

### 6. Cache do lookup de `Template` no envio — hoje inexistente

`TemplateRepository.findByIdAndProjectId` é chamado direto pelo `SendEmailUseCase` em todo envio,
sem cache — o mesmo hot path que já justificou `SenderIdentityCacheProvider` na spec anterior, e que
o próprio `apps/core-server/CLAUDE.md` cita como exemplo canônico do padrão de cache do módulo
("Declare algo como `TemplateCacheProvider`"). Com `text` se somando a `subject`/`html`, a linha
buscada a cada envio fica ainda mais pesada.

```ts
// templates/domain/contracts/template-cache.provider.ts
export interface TemplateCacheProvider {
  get(input: { templateId: string; projectId: string }): Promise<Either<BaseError, Template | null>>
  invalidate(input: { templateId: string }): Promise<void>
}
```

Implementação sobre `GET_OR_SET_CACHE_PROVIDER` (`@ruguin/cache`), namespace `'core-server-template'`
(hífen, não `:` — regra do `KeyBuilder`, mesma restrição já documentada para o cache de
`SenderIdentity`/`ApiKey`). TTL configurável (`TEMPLATE_CACHE_TTL_IN_SECONDS`, mesmo padrão de
`SENDER_IDENTITY_CACHE_TTL_IN_SECONDS`/`API_KEY_CACHE_TTL_IN_SECONDS`, default 300).
`SendEmailUseCase` passa a injetar `TEMPLATE_CACHE_PROVIDER` em vez de `TEMPLATE_LOOKUP_PROVIDER`
diretamente — o contract de lookup continua existindo, usado pelo adapter de cache no miss.

`invalidate()` fica sem nenhum chamador nesta spec — não existe hoje caminho de escrita de
`Template` fora do seed. Incluído por simetria estrutural com `SenderIdentityCacheProvider` (mesma
decisão já tomada naquele módulo), para o contract não precisar mudar de forma quando o CRUD de
`Template` existir.

### 7. Seed

`prisma/seed.ts` passa a importar `renderWelcomeEmailTemplate` de `@ruguin/email-templates` e usa o
resultado (`{ subject, html, text }`, ainda com `{{name}}` literal) para criar o `Template` — troca
só a origem do conteúdo, a chamada `prisma.template.create(...)` continua igual.

## Fluxo de dados

**Autoria/build:**

1. Dev escreve/edita `packages/email-templates/src/templates/welcome.tsx`; testa com
   `pnpm --filter @ruguin/email-templates dev` (preview ao vivo no navegador).
2. `pnpm --filter @ruguin/email-templates build` gera `dist/`.
3. `prisma/seed.ts` chama `renderWelcomeEmailTemplate()`, cria `Template` com `subject`/`html`/`text`
   (placeholders ainda literais).

**Envio — `POST /v1/emails { to, templateId, variables }`** (sem mudança na forma, só no que cada
passo lê/escreve):

1. `ApiKeyAuthGuard` resolve `projectId`/`organizationId` — sem mudança.
2. `TemplateCacheProvider.get(templateId, projectId)` — não encontrado/de outro projeto → `404`
   (mesmo comportamento de hoje, agora servido por cache-aside em vez de leitura direta).
3. `SenderIdentityCacheProvider.get(template.senderIdentityId)` — sem mudança (spec anterior).
4. Renderização `{{var}}` nos três campos (`subject`, `html`, `text`) — variável ausente em
   qualquer um deles → `422`, mesmo erro de hoje.
5. `Email.create(...)` com `text` preenchido junto de `subject`/`html`.
6. `createIfNotExists` + outbox na mesma transação — payload do evento ganha `text`.
7. Sucesso → `202 { id, status: 'queued' }`.

**Consumo (`dispatch-worker`):** `SendEmailUseCaseInput`/porta do sender ganham `text`;
`SesEmailSender` monta `Body: { Html, Text }` em vez de só `Html`.

## Testes

- **Unit**: `packages/email-templates`'s `render.ts` (subject/html/text contêm `{{name}}` literal,
  estrutura básica do HTML gerado); `renderTemplate` estendido para o terceiro campo;
  `Template.create`/`Email.create` com `text` vazio rejeitado; `TemplateCacheProvider` (hit
  reidrata a classe de domínio corretamente — mesma classe de bug já encontrada e corrigida no
  `SenderIdentityCacheProvider`, vale replicar o teste de round-trip de serialização aqui também);
  `SendEmailUseCase` cobrindo o `text` no payload publicado; `SesEmailSender` cobrindo
  `Body.Text.Data`.
- **Integration** (Postgres real): `EmailRepository`'s comparação de idempotência incluindo `text`
  na decisão replay-vs-conflito.
- **E2E**: assert de conteúdo persistido em `email.controller.e2e.ts` passa a checar `email.text`
  também, além de `subject`/`html`.

## Fora de escopo

- CRUD HTTP de `Template` — continua só via seed (`invalidate()` do cache fica sem chamador até
  existir).
- Templates além do `Welcome` já semeado — a estrutura fica pronta, mas nenhum template novo é
  criado nesta spec.
- Envio agendado — subsistema próprio, spec futura.
- Migração de templates/e-mails já persistidos — projeto em pré-produção, sem necessidade de
  backfill para `text` passar a ser obrigatório (mesma postura já adotada para
  `Template.senderIdentityId`/`Email.senderIdentityId` na spec anterior).

## Riscos

- **Qualidade do texto plano é a que `@react-email/render` extrai do JSX, não uma autoria dedicada.**
  Para o componente `Welcome` (simples) isso não deve ser um problema perceptível; templates futuros
  mais ricos (tabelas, layout complexo) podem gerar um texto plano menos legível — decisão aceita
  aqui, revisitável spec a spec.
- **`packages/email-templates` precisa compilar JSX** — configuração de `tsconfig`/`tsdown` diferente
  dos demais pacotes do workspace (que são só TypeScript puro, sem JSX). A confirmar na
  implementação que o `tsdown` lida com isso sem ajuste maior de toolchain.
- **TTL do cache de `Template` mascara uma atualização por até `TEMPLATE_CACHE_TTL_IN_SECONDS`** —
  hoje sem impacto prático (não existe caminho de escrita), mas passa a valer no dia em que o CRUD
  de `Template` existir. Mesma classe de risco já aceita para os outros TTLs do módulo.
