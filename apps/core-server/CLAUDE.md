# CLAUDE.md

Guia para o Claude Code (claude.ai/code) ao trabalhar neste app.

## Propósito

`@ruguin/core-server` — o API Service do produto. É dono da autenticação, da gestão de conta
(organizações, projetos, API keys, templates, domínios) e recebe as requisições de envio. É o dono
exclusivo do seu schema Postgres: nenhum outro serviço lê ou escreve nessas tabelas, e todo fato que
ele publica para o resto do sistema sai como evento Kafka.

Hoje `src/` tem infraestrutura e `shared/`. O layout abaixo é a forma que o primeiro módulo de
negócio precisa ter, porque ele vira o precedente que os outros sete copiam.

## Estrutura

```text
apps/core-server/
  src/
    <module>/                     # organization, project, api-key, template, domain, email,
                                  # webhook-endpoint, suppression
      domain/
        models/                   # aggregate roots e entidades — nunca tipos do Prisma
        value-objects/            # VOs do módulo
        errors/                   # erros deste módulo (estendem BaseError)
        contracts/                # TODOS os ports: repositórios, providers, gateways
      application/
        controllers/              # entrada HTTP
          dtos/
        listeners/                # entrada Kafka (só quando existir consumidor de fato)
        services/                 # encaminha para o use case
        use-cases/                # um arquivo por use case — única casa da lógica de negócio
      infra/
        database/prisma/          # adapters de repositório
        cache/                    # adapters sobre @ruguin/cache
      <module>.module.ts          # liga cada contract ao seu adapter
      **/__tests__/               # ao lado do código coberto, nunca uma pasta por módulo
    shared/
      contracts/                  # TransactionContext, TransactionManager
      database/                   # PrismaService, PrismaTransactionManager, DatabaseModule,
                                  # DatabaseHealthIndicator
      errors/                     # erros que não pertencem a nenhum módulo (TransactionError)
      outbox/                     # OutboxRepository + relay  [ainda não implementado]
      events/                     # adapter sobre packages/message-broker  [ainda não implementado]
    bootstrap/                    # configureApp: docs, security headers, versioning
    cache/                        # mapeia o env validado nas options do CacheModule
    generated/prisma/             # client do Prisma — gerado, fora do git, nunca editado
    health/ logger/ tracing/      # infraestrutura transversal
    app.module.ts main.ts
  prisma/
    schema/
      schema.prisma               # datasource + generator, nada mais
      outbox.prisma               # um .prisma por módulo, mais o outbox
    migrations/
  prisma.config.ts                # aponta o CLI para a PASTA prisma/schema
```

**Módulo, não bounded context.** O bounded context é este serviço inteiro; `src/<module>/` é um
sub-domínio dentro dele.

## Regra de dependência

```text
{ Controller | Listener } → Service → Use Case → { Contract | Model | Value Object }
                                                        ↑
                                             infra/ implementa os contracts
```

A regra de chamada acima é acompanhada de uma regra de import, que é o que se consegue verificar:

- **`domain/` não importa de `application/`, de `infra/`, nem de framework algum** — nada de Nest,
  Prisma ou Fastify. Um `grep` por esses nomes dentro de `domain/` deve voltar vazio.
- **`application/` importa de `domain/`, nunca de `infra/`.**
- **`infra/` importa de `domain/`** — é onde os contracts ganham corpo.
- **`<module>.module.ts` é o único arquivo que enxerga as três camadas.** É o composition root.

## Regras

- **Nenhuma camada pula a próxima.** Um controller que alcança um repositório, ou um use case que
  toca no Prisma, quebra a costura que torna a camada de baixo testável isoladamente.
- **`Service` só encaminha.** Sem lógica, sem branching, sem acesso a repositório — chama um use
  case e retorna. Isso é deliberado: a assinatura uniforme do controller é o ponto, e essa camada é
  onde um futuro concern transversal entra sem tocar em todos os use cases. Não apague porque "não
  faz nada"; é justamente o trabalho dela.
- **Listener entra pela mesma porta que o controller.** Adapta o payload do evento e chama um
  service. Consumo é at-least-once, então o use case por trás tem que ser idempotente — a
  deduplicação é responsabilidade dele, não do listener.
- **Um use case nunca chama outro use case.** Quando uma operação precisa de dois, escreva um use
  case de orquestração que fala com os dois repositórios dentro de uma transação. Lógica
  reaproveitável vira método de `Model`/VO ou provider — uma cadeia de use cases esconde quem é dono
  do limite da transação.
- **`Model` nunca é o tipo do Prisma.** É uma classe de domínio cujas invariantes são checadas num
  `Model.create(...)` estático que devolve `Either`, como o value object `ID`. Traduzir entre linha
  do Prisma e `Model` é o mapper privado do repositório e de mais ninguém.
- **Contract em `domain/contracts/`, adapter em `infra/`, ligados por token no módulo.** Essa
  indireção é o que deixa um `.unit.ts` mockar um repositório sem banco. Um contract cuja única
  implementação é uma classe Prisma continua sendo um contract.
- **Contract nunca menciona o Prisma.** Transação atravessa como `TransactionContext`
  (`shared/contracts/`), um tipo opaco cujo símbolo de marca não é exportado. O preço disso é o cast
  `tx as unknown as Prisma.TransactionClient`, esperado em **qualquer** repositório cujo método
  recebe um `TransactionContext` e precisa rodar Prisma em cima dele — hoje `outbox.repository.ts` e
  `emails/infrastructure/database/prisma/email.repository.ts`, ambos na primeira linha do método. O
  que a regra proíbe é o Prisma aparecer na assinatura do contract, não o cast dentro do adapter que
  o implementa.
- **Repositórios traduzem erro de infraestrutura em erro de domínio.** Violação da constraint única
  de idempotência não é uma coisa só: quando o conteúdo da linha existente bate com o da requisição
  nova, é replay e vira sucesso com `created: false`; quando não bate, vira
  `EmailIdempotencyConflictError` com `StatusError.CONFLICT`. Devolver a linha antiga para um corpo
  diferente responderia 202 a uma mensagem que nunca é enfileirada nem enviada — perda silenciosa
  disfarçada de sucesso. Nada do namespace `Prisma.*` pode cruzar para `application/` ou `domain/`.
- **Toda falha esperada devolve `Either`; `throw` é para bug.** A exceção sancionada é
  `RollbackSignal`, privada de `prisma-transaction-manager.ts`: ela existe porque o Prisma só faz
  rollback com exceção, enquanto o resto do código reporta falha por valor. Ela nunca escapa desse
  arquivo — e há teste cobrindo exatamente isso.
- **Anote o tipo de retorno de qualquer função que devolva `Either`.** `success(x)` sozinho infere
  `Either<unknown, X>`, porque o parâmetro de erro não aparece nos argumentos. Sem a anotação, o
  valor não encaixa onde se espera `Either<BaseError, X>` e o erro de tipo aparece longe da causa.
- **Ler dado de outro módulo passa pelo seu próprio contract.** Declare `<Aggregate>LookupProvider`
  em `domain/contracts/` e implemente em `infra/`. Importar o repositório de outro módulo acopla
  você à persistência dele.
- **Cache consumido por um use case passa por um contract do módulo.** Declare algo como
  `TemplateCacheProvider` (`getTemplate`, `invalidateTemplate`) sobre `@ruguin/cache`. O use case
  fala o próprio domínio em vez de namespaces e TTLs, e o teste dele mocka dois métodos em vez de
  vinte e cinco. A regra para em `infrastructure/`: `ApiKeyAuthGuard` injeta
  `GET_OR_SET_CACHE_PROVIDER` direto e escolhe namespace e TTL sozinho, porque um guard já é adapter
  da borda HTTP — não é um use case falando o próprio domínio, e envolvê-lo num contract não
  protegeria camada alguma.
- **Evento sai pelo outbox, na mesma transação da escrita.** Publicar no Kafka de dentro de um use
  case cria uma transação distribuída implícita: a linha commita e o evento se perde, ou o inverso.
  O relay publica depois do commit.
- **Testes em `__tests__/` ao lado do código** — `*.unit.ts` (sem I/O), `*.int.ts` (Postgres/Valkey
  reais), `*.e2e.ts` (HTTP pelo app buildado). Um use case nunca tem `.int.ts`: ele só depende de
  contracts.
- **Sem CQRS, sem Event Sourcing, sem nome de entidade prefixado por módulo.** Os padrões de
  leitura e escrita ainda não divergem, não há requisito de auditoria, e o prefixo existe para
  evitar colisão entre bibliotecas publicadas de forma independente — aqui um schema e um serviço já
  desambiguam, e o módulo está no caminho do arquivo.

## Prisma

Versão **7.x**, generator `prisma-client` (o sucessor TypeScript do `prisma-client-js`). A linha
`prisma-next` é pre-1.0 e a própria documentação desaconselha em produção.

- **Um `.prisma` por módulo em `prisma/schema/`.** Um arquivo único cruza o limite de 500 linhas do
  repo por volta do quarto módulo, e o diff dele não diz qual módulo mudou.
- **`prisma.config.ts` não é opcional.** A pasta `prisma/schema/` é invisível para a auto-detecção
  do CLI, que só procura `prisma/schema.prisma` como arquivo. Sem o config apontando para a pasta, o
  Prisma não acha schema nenhum — não existe fallback silencioso.
- **`datasource` não declara `url`.** No Prisma 7 a conexão vem de `prisma.config.ts`, que lê
  `DATABASE_URL`. Todo comando prisma precisa de `pnpm with-env` (dotenvx) na frente.
- **Um schema Postgres, `core_server`, via `?schema=core_server` na URL.** Schema é por serviço, não
  por módulo — os outros cinco serviços do product-spec dividem este database com schemas próprios.
  Módulo se isola por contract e repositório, não por namespace de banco.
- **O `?schema=` da URL não chega ao driver adapter.** `PrismaPg` recebe o schema por opção separada;
  sem ela, qualifica as queries como `public.<tabela>` enquanto as migrations foram para
  `core_server`. `resolveSchemaFrom` deriva um do outro para que não possam divergir.
- **`importFileExtension = "js"` no generator.** O default emite `from './enums.ts'`, e o
  `scripts/fix-esm-imports.mjs` acrescenta `.js` ao que não termina em `.js` — o resultado era
  `./enums.ts.js`, um caminho que só quebra em runtime.
- **O client gerado fica em `src/generated/`, fora do git.** São ~3 mil linhas para um único modelo.
  O `build` roda `prisma generate` antes de compilar, o eslint ignora a pasta, e ela está nos
  `outputs` do turbo — sem isso um cache hit restauraria `dist/` sem o client.
- **`PrismaService` não chama `$connect` no boot.** O Prisma abre a conexão na primeira query;
  forçá-la no start mataria o processo sempre que o Postgres estivesse fora, inclusive nas suítes
  e2e. Quem responde pela disponibilidade do banco é o `/health`.

## Health check

`GET /health` agrega dois indicadores, ambos declarados no `HealthModule` — que é o módulo que
importa o `TerminusModule`. Nem `CacheModule` nem `DatabaseModule` registram indicador próprio:
fazê-lo empurraria `@nestjs/terminus` para todo consumidor, inclusive os que não têm superfície HTTP.

- **`cache`** — `degraded` conta como up. Tirar a instância do load balancer porque uma réplica
  sumiu transformaria degradação em indisponibilidade; só master inalcançável marca down.
- **`database`** — `SELECT 1`, que exercita pool, rede, autenticação e permissão no schema sem
  depender de tabela alguma. Banco fora é down sem meio-termo: não há modo em que o serviço siga
  aceitando envios sem persistir. A resposta traz `latencyInMs` no caminho feliz e, na falha, a
  mensagem do Prisma colapsada em uma linha e truncada — o corpo do health é lido por agregador de
  log e regra de alerta, não por humano no terminal.

Um indicador **nunca lança**: o Terminus derruba a resposta inteira quando isso acontece, e o
diagnóstico do outro indicador se perde junto. Falha vira `status: 'down'` com o motivo no corpo.

Por isso `test:e2e` exige Postgres de pé (`docker compose up -d`) — sem ele `/health` responde 503,
que é a resposta certa, não um defeito do teste.

## Comandos

```bash
pnpm --filter @ruguin/core-server test              # unit, sem infraestrutura
pnpm --filter @ruguin/core-server test:integration
pnpm --filter @ruguin/core-server test:e2e          # precisa de docker compose up -d
pnpm --filter @ruguin/core-server check:types
pnpm --filter @ruguin/core-server check:lint
pnpm --filter @ruguin/core-server build             # prisma generate + nest build + fix-esm-imports

pnpm with-env pnpm --filter @ruguin/core-server db:migrate   # cria e aplica migration
pnpm with-env pnpm --filter @ruguin/core-server db:deploy    # aplica migrations existentes
pnpm --filter @ruguin/core-server db:generate                # só o client, dispensa DATABASE_URL
pnpm with-env pnpm --filter @ruguin/core-server start
```

`tsconfig.build.json` define `noEmit: true` de propósito — o SWC emite, o tsc só checa tipo.
Remover isso faz o TypeScript exigir um `rootDir` explícito, e defini-lo move a saída para
`dist/src/`.

## Relacionados

- `docs/superpowers/specs/2026-08-01-core-server-modular-architecture-design.md` — a decisão desta
  estrutura e onde ela diverge do spec anterior
- `docs/superpowers/specs/2026-07-29-core-server-architecture-design.md` — a arquitetura original;
  ainda vale para transaction manager e outbox, mas o layout de pastas e o `RollbackSignal` foram
  revisados pelo spec acima
- `packages/cache/CLAUDE.md` — os contracts de cache sobre os quais estes módulos constroem
