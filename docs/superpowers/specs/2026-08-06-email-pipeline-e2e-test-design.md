# EMAIL-6 — Teste ponta a ponta do pipeline de envio — Design

**Data:** 2026-08-06
**Escopo:** um teste novo, sem tocar em código de produção de `apps/core-server` nem
`apps/dispatch-worker`. Ticket: `docs/tasks/EMAIL-6-teste-e2e-pipeline-envio.md`.

## Contexto

Cada peça do pipeline de envio já tem teste próprio: `apps/core-server`'s
`email.controller.e2e.ts` prova que `POST /v1/emails` responde certo e grava a linha em Postgres;
`apps/dispatch-worker`'s `dispatch-email.e2e.ts` prova que, publicando diretamente em
`email.send.requested`, o worker chama a SES (via LocalStack) e publica `email.status.updated`. O
que nenhum teste hoje comprova é a costura entre os dois: que uma chamada HTTP real ao core-server
produz um evento que o dispatch-worker real consome e processa — a integração pode estar quebrada
(nome de tópico errado, formato de payload divergente, outbox relay não disparando) mesmo com as
duas pontas individualmente verdes.

EMAIL-6 depende de EMAIL-4 e EMAIL-5, ambos prontos. Este design cobre só a mecânica do teste — o
comportamento de negócio que ele exercita já existe e não muda.

## Objetivo

Um teste automatizado que roda `apps/core-server` e `apps/dispatch-worker` como dois processos Node
reais e independentes (não dois `AppModule` no mesmo processo, não um roteiro manual), chama
`POST /v1/emails` por HTTP de verdade contra o core-server real, e observa `email.status.updated`
com `status: 'sent'` e `sesMessageId` presente via um consumer Kafka dedicado — provando que os dois
processos, falando só por HTTP/Postgres/Kafka/SES (exatamente como em produção), completam o
caminho de sucesso.

Não cobre: cenários de falha (já cobertos no EMAIL-5), rastrear o `status=queued` da linha
`emails` no Postgres depois do envio (é responsabilidade do Read-Model Updater, ainda não
construído — nota explícita do próprio ticket), qualquer mudança de comportamento nos dois apps.

## Decisões

### 1. Dois processos reais, não um boot em processo único

Avaliadas três formas de ter o dispatch-worker "rodando" durante o teste: (a) processos reais
separados via `child_process`, comunicando-se só por HTTP/Kafka; (b) os dois `AppModule` importados
e inicializados no mesmo processo Vitest; (c) roteiro manual, sem automação.

Escolhida (a). Motivos:

- É a leitura mais fiel do próprio ticket ("sistema real rodando... não substituído por simulações
  internas", "API Service + Dispatch Worker... rodando juntas").
- (b) exigiria um pacote novo com dependência cruzada `core-server` ↔ `dispatch-worker` — nenhum dos
  dois é hoje uma biblioteca importável pelo outro, e a regra de dependência de
  `apps/core-server/CLAUDE.md` trata cada serviço como dono exclusivo do seu runtime. Também
  colidiria em silêncio com o `groupId` fixo (`'dispatch-worker'`) que o e2e do próprio
  dispatch-worker já usa, caso os dois rodem em paralelo no CI (ver decisão 2).
- (c) foge do padrão 100% automatizado que todo o resto do projeto segue.
- (a) não introduz nenhuma ferramenta nova — `node:child_process` é nativo, `pnpm --filter <app>
  start` já existe em ambos os `package.json`.

### 2. Localização do teste e comando

Novo arquivo em `apps/core-server/src/__tests__/email-pipeline.e2e.ts` (nível de topo, ao lado de
`decorator-metadata.unit.ts` — o mesmo lugar reservado a testes que não pertencem a um módulo
específico) — vive no core-server porque é ele quem tem hoje o mecanismo de seed usado pelos e2e
(`vitest.setup.e2e.ts` + `prisma/seed.ts`), e porque `POST /v1/emails` é o ponto de entrada do
teste. O teste não importa nada de `apps/dispatch-worker` — só o inicia como processo externo.

O projeto `e2e` existente do `vitest.config.ts` casa `include: ['src/**/__tests__/**/*.e2e.ts']` —
sem ajuste, esse glob pegaria o arquivo novo também, colocando-o dentro de `test:e2e`/`test:all`,
que roda em paralelo com o `test:e2e` do dispatch-worker no CI e colidiria no `groupId` fixo dele
(detalhe no parágrafo "Motivo de isolar" abaixo). Dois ajustes no `vitest.config.ts`:

1. O projeto `e2e` ganha `exclude: ['src/__tests__/email-pipeline.e2e.ts']`.
2. Um projeto novo, `pipeline-e2e`, com `include: ['src/__tests__/email-pipeline.e2e.ts']` e seu
   próprio `globalSetup` (decisão 3, passo 1).

E um script dedicado em `package.json`:

```json
"test:pipeline-e2e": "pnpm run build && pnpm --filter @ruguin/dispatch-worker build && vitest run --project pipeline-e2e"
```

Motivo de isolar: (1) precisa dos dois apps já buildados em `dist/` — `pnpm --filter <app> start`
roda a partir de `dist/`, não de `src/`; (2) sobe processos reais, é ordens de magnitude mais lento
que o resto do `e2e` (que só usa `app.inject()` em processo); (3) usa o mesmo `groupId` fixo que o
e2e do dispatch-worker — rodar os dois ao mesmo tempo faria um roubar mensagem do outro (mesmo
motivo por que o `vitest.config.ts` do dispatch-worker já desliga `fileParallelism` para os
arquivos `.e2e.ts` dele). `test:pipeline-e2e` fica de fora do grafo do Turbo
(`turbo.json`'s `test:all`/`test:e2e` não ganham essa task) — quem quiser rodar tudo em CI o chama
como um step explícito e sequencial, depois dos `test:e2e` de cada app.

### 3. Orquestração dos processos

`beforeAll` do teste:

1. Roda `prisma/seed.ts` do jeito que `vitest.setup.e2e.ts` já roda (mesmo `execSync`, mesmo parse
   de stdout) — reaproveita a função em vez de duplicá-la (ver decisão 5). Não precisa de
   `globalSetup` separado: como o teste já não entra no projeto `e2e`, define seu próprio
   `globalSetup` em `vitest.config.ts` apontando para o mesmo arquivo.
2. Chama `VerifyEmailIdentityCommand` no `SESClient` (LocalStack) para o e-mail do `SenderIdentity`
   semeado. Necessário porque `prisma/seed.ts` grava `verifiedAt` direto no Postgres sem nunca
   chamar a SES real (decisão 9 do plano de SenderIdentity) — o LocalStack não tem esse identity
   registrado, e `SesEmailSender` (`apps/dispatch-worker/src/email/infra/ses/ses-email-sender.ts`)
   usa `input.from` (que vem do `SenderIdentity.email`) como `Source:` do `SendEmailCommand`. Sem
   este passo o envio real falharia na SES por identity não verificado — o mesmo motivo pelo qual o
   e2e do dispatch-worker já faz isso hoje para o endereço dele.
3. Spawna os dois processos via `child_process.spawn('pnpm', ['--filter', '<pkg>', 'start'], {
   env, stdio: 'pipe' })` — um para `@ruguin/core-server`, um para `@ruguin/dispatch-worker`. `env`
   é `{ ...process.env, ...overrides }`, com os mesmos overrides que `vitest.setup.e2e.ts` já usa
   por `??=` (`DATABASE_URL` com `?schema=core_server`, `KAFKA_BOOTSTRAP_BROKERS`,
   `AWS_ENDPOINT_URL`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) — precisa ser explícito porque um
   `pnpm start` fora de contexto de teste não tem garantia de herdar esses valores do `.env` raiz.
   `stdout`/`stderr` de cada processo vão para um buffer em memória, despejado no teste só se o
   `beforeAll` falhar (diagnóstico sem poluir a saída normal).
4. Espera os dois `/health` responderem 200 (`GET http://localhost:3333/health` para core-server,
   `GET http://localhost:3334/health` para dispatch-worker — portas de `packages/env`'s
   `serverENV.PORT` default e o hardcoded do dispatch-worker) via polling simples (`fetch` a cada
   500ms, timeout de 30s) — não existe hoje nenhum "wait-for-healthy" no repo, e nenhuma ferramenta
   nova é justificável para um polling deste tamanho.

`afterAll`: mata os dois processos (`SIGTERM`, com fallback `SIGKILL` se não sair em 5s) e fecha o
producer/consumer Kafka do teste.

### 4. Observando o evento de status

O teste não importa `AppModule` de nenhum dos dois apps. Para publicar a chamada e observar o
resultado ele usa só pacotes compartilhados já pensados para consumo externo:

- HTTP: `fetch('http://localhost:3333/v1/emails', ...)` puro — sem client gerado, sem SDK.
- Kafka: um `Test.createTestingModule` mínimo que importa só `MessageBrokerModule`
  (`@ruguin/message-broker`, pacote compartilhado — não é cross-import entre apps) para obter
  `MESSAGE_CONSUMER_PORT`/`MESSAGE_PRODUCER_PORT`, exatamente como `dispatch-email.e2e.ts` já faz
  hoje (`consumer.subscribe({ topic: EMAIL_STATUS_UPDATED_TOPIC, groupId: `pipeline-e2e-${Date.now()}`,
  ... })`, `vi.waitUntil` com o mesmo padrão de timeout/interval).

O `groupId` do teste é gerado com `Date.now()` (descartável, único por execução) — só o consumer
group interno do dispatch-worker (`'dispatch-worker'`) é fixo, e é exatamente por isso que este
teste roda sozinho (decisão 2).

### 5. Reuso do parsing do seed em vez de duplicação

`vitest.setup.e2e.ts` já tem a lógica de `execSync('pnpm exec tsx prisma/seed.ts', ...)` + parse de
stdout para `organizationId`/`projectId`/`senderIdentityId`/`templateId`/`apiKey`
(`apps/core-server/vitest.setup.e2e.ts:41-75`). Extrai essa lógica para uma função exportada
(`runSeedAndCaptureIds()`) num módulo compartilhado dentro de `apps/core-server` (ex.:
`apps/core-server/prisma/run-seed.ts`), chamada tanto pelo `globalSetup` do projeto `e2e` quanto
pelo novo `globalSetup` do projeto `pipeline-e2e`. Evita duas cópias do mesmo parsing de stdout
divergindo com o tempo.

### 6. Corpo da requisição e asserts

`POST /v1/emails` com `{ to: 'e2e-recipient@example.com', templateId: <seeded templateId>, variables:
{ name: 'Pipeline E2E' } }` e header `Authorization: Bearer <seeded apiKey>` — mesmo formato usado
por `email.controller.e2e.ts`. `from` não vai no corpo: é resolvido server-side a partir do
`SenderIdentity` ligado ao template (`send-email.use-case.ts:93`), que é exatamente o que a decisão
3.2 verifica na SES antes do teste.

Asserts:

1. A resposta do `POST` é `202` com um `id` de string não vazia — captura esse `id` para
   correlacionar com o evento.
2. Dentro do timeout do `vi.waitUntil`, chega uma mensagem em `email.status.updated` com
   `emailId === id` (o campo que `dispatch-worker`'s `publishStatusUpdated` usa, ver
   `send-email.use-case.ts:218-238` do dispatch-worker), `status: 'sent'`, e `sesMessageId` como
   string não vazia.

### 7. Timeout do teste

O caminho de sucesso não tem backoff/retry — vai direto: outbox relay do core-server dispara a cada
1s (`RELAY_INTERVAL_MS`, `outbox-relay.service.ts:17`), dispatch-worker consome quase
imediatamente, chama a SES (LocalStack, latência mínima) e publica o status. Um timeout de 20s no
`vi.waitUntil` do evento (mesma ordem de grandeza do `dispatch-email.e2e.ts` existente, que usa 15s
para um cenário sem HTTP na frente) e 60s no timeout do teste inteiro (`it(..., { timeout: 60_000
})`) — folga suficiente para o boot dos dois processos reais (a parte mais lenta) sem mascarar uma
regressão real de latência.

## Testes

Só este arquivo novo — não há unidade a testar isoladamente (é ele mesmo o teste de
integração/e2e). Roda contra a infraestrutura real do `docker compose` (`pnpm infra:up`), como todo
`.e2e.ts` do repo hoje. Precisa de `pnpm build` do core-server e do dispatch-worker antes (o próprio
script `test:pipeline-e2e` cuida disso).

## Fora de escopo

- Rodar `test:pipeline-e2e` automaticamente dentro de `test:all`/`test:e2e` via Turbo — fica como
  step manual/CI explícito por causa do `groupId` fixo (decisão 2). Automatizar isso no pipeline de
  CI, se desejado, é uma mudança de infra separada, não deste ticket.
- Cenários de falha ponta a ponta (SES fora do ar, mensagem malformada) — já cobertos no EMAIL-5,
  o próprio ticket exclui explicitamente repeti-los aqui.
- Atualizar o `status` da linha `emails` no Postgres — trabalho do Read-Model Updater, `[Planejado]`
  no `product-spec.md`, fora do conjunto de tickets EMAIL-1 a EMAIL-6.
