# Core Server — Arquitetura modular + Prisma — Design

**Data:** 2026-08-01
**Escopo:** `apps/core-server` (layout de módulo, camada de dados), `packages/env` (subpath `./database`)

## Contexto

O spec de 2026-07-29 definiu a arquitetura do `core-server` e a `CLAUDE.md` do app a detalhou, mas
nenhum módulo de negócio existe ainda — `src/` tem só infraestrutura. Como o primeiro módulo vira o
precedente que os outros sete copiam, vale acertar o layout antes de escrever o primeiro.

Duas coisas motivaram a revisão. Primeiro, o layout anterior separava `presentation/` de
`application/` e punha os ports em `application/repositories|providers`, enquanto `packages/cache` —
o pacote mais maduro do repo — já usa `domain/contracts` + `application` + `infra`. Os dois padrões
convivendo no mesmo monorepo custam mais do que qualquer um deles isolado. Segundo, o serviço
precisa de ORM e não tinha nenhum.

## Objetivo

Fixar um layout de módulo único para app e packages, e deixar a camada de dados funcionando
(Prisma 7 conectando, migrando e testado) sem implementar nenhuma feature de domínio.

## Decisões

### 1. `domain/contracts/` concentra os ports

Todos os ports — repositórios, providers, gateways — vivem em `domain/contracts/`. A leitura
ortodoxa colocaria repositório em `application/` por ele falar de persistência; o argumento
contrário, que venceu, é que um único lugar deve responder "o que este módulo precisa do mundo", e
que é exatamente o layout que `packages/cache` já provou.

### 2. `application/` abriga controllers, listeners, services e use-cases

`presentation/` deixa de existir. Controller e listener não contêm lógica: são adaptadores de
entrada, e ficam ao lado do use case que servem em vez de numa camada própria. Listener entra pela
mesma porta que controller.

A regra de import é o que se consegue verificar mecanicamente: `domain/` não importa de
`application/`, de `infra/` nem de framework; `application/` não importa de `infra/`; só o
`<module>.module.ts` vê as três.

### 3. `TransactionContext` opaco, para o Prisma não vazar ao domínio

Com os contracts em `domain/`, um `tx?: Prisma.TransactionClient` levaria o ORM para dentro do
domínio. `shared/contracts/transaction-context.contract.ts` declara um tipo cuja marca é um
`unique symbol` não exportado: ninguém consegue produzir um valor dele, e o único cast para
`Prisma.TransactionClient` está confinado a `PrismaTransactionManager`.

### 4. `RollbackSignal` é de fato privado — divergência do spec anterior

O spec de 2026-07-29 dizia que `RollbackSignal` "nunca vaza para fora do `TransactionManager`", mas o
exemplo dele tinha o use case executando `throw new RollbackSignal(...)`. As duas afirmações não
podem valer juntas.

Aqui `execute` recebe um `work` que **devolve `Either`**, e converte um `Failure` em rollback
internamente. O use case nunca vê o sinal, e escreve código sem exceções:

```ts
return this.transactionManager.execute(async (tx): Promise<Either<SaveEmailError, Email>> => {
  const saved = await this.emailRepository.save({ email, tx })
  if (saved.isFailure()) return saved
  return success(saved.value.emailSaved)
})
```

`prisma-transaction-manager.unit.ts` cobre os quatro caminhos, incluindo o que o spec anterior
marcava como risco: um `Failure` de negócio jamais chega ao chamador como exceção.

### 5. Prisma 7 clássico, não `prisma-next`

A documentação do próprio projeto: *"Prisma Next is currently in a pre-1.0 state... It is recommended
to use Prisma 7 for production applications."* Versão instalada: 7.9.1, generator `prisma-client`.

O Node do repo é 26.5.0 e o `preinstall` do Prisma avisa suportar até 24.0+ — o CLI e o runtime
foram exercitados e funcionam; o aviso é conservador, mas é uma incompatibilidade declarada a
observar em upgrades.

### 6. Um schema Postgres, vários arquivos `.prisma`

`prisma/schema/` com um `.prisma` por módulo, lidos como um schema só. Todas as tabelas em
`core_server.*`, via `?schema=core_server`.

Um schema Postgres **por módulo** (`multiSchema`) foi considerado e recusado: a NFR 4.2 do
product-spec fala em schema por *serviço*; o isolamento entre módulos aqui é de código, não de banco;
e a tabela outbox é cross-module por design, sem lugar óbvio nesse esquema.

### 7. Exports dos packages: barrel único, em PR separado

Ficou decidido colapsar todos os `package.json` de packages para apenas `"." : "./src/index.ts"`,
tornando o `@ruguin/env` lazy no mesmo movimento. Hoje o barrel do env avalia `createEnv` de todos os
arquivos na importação — verificado empiricamente: com apenas `DATABASE_URL` definida,
`@ruguin/env/database` resolve e `@ruguin/env` falha exigindo as variáveis de todos os schemas.
Colapsar sem tornar lazy quebraria o boot.

Este design mantém o subpath `./database` que acabou de ser adicionado, coerente com `./cache` e
`./docs` existentes. O colapso é um PR próprio, que toca env, cache e todos os imports do app.

## Achados do Prisma 7 que viraram regra

Três comportamentos não óbvios, cada um descoberto por falha real:

| Comportamento | Sintoma | Resolução |
|---|---|---|
| `prisma/schema/` não é auto-detectada | CLI não acha schema nenhum | `prisma.config.ts` com `schema: './prisma/schema'` |
| `?schema=` da URL não chega ao driver adapter | queries em `public.*`, migrations em `core_server.*`, erro só em runtime | `resolveSchemaFrom` deriva o schema da mesma URL e o passa ao `PrismaPg` |
| generator emite `from './enums.ts'` | `fix-esm-imports.mjs` produz `./enums.ts.js`, quebra em runtime | `importFileExtension = "js"` |

O client gerado fica em `src/generated/`, fora do git (~3 mil linhas para um modelo), regenerado pelo
`build`, ignorado pelo eslint e declarado nos `outputs` do turbo — sem a última parte, um cache hit
restauraria `dist/` sem o client.

### 8. Conexão lazy + `/health` como fonte de verdade do banco

`PrismaService` não chama `$connect` no boot. Forçar a conexão no start mataria o processo sempre
que o Postgres estivesse indisponível — inclusive nas suítes e2e desenhadas para rodar sem
infraestrutura. O Prisma abre a conexão na primeira query de qualquer forma.

O contrapeso é `DatabaseHealthIndicator`, somado ao `CacheHealthIndicator` que já existia:
`GET /health` agora responde pelos dois. `SELECT 1` exercita pool, rede, autenticação e permissão no
schema sem depender de tabela, então vale antes da primeira migration. Banco fora é `down` sem
meio-termo — não há modo degradado em que o serviço aceite envios sem persistir.

Nenhum indicador lança: o Terminus derruba a resposta inteira quando um deles quebra, e o
diagnóstico do outro se perde. A mensagem de erro do Prisma é colapsada em uma linha e truncada em
200 caracteres, porque o corpo do health é consumido por agregador de log e regra de alerta.

Consequência assumida: `test:e2e` passa a exigir Postgres — um `/health` que responde 200 sem banco
estaria mentindo. A `DATABASE_URL` das suítes vive em `vitest.setup.e2e.ts`, carregado pelo projeto
`e2e`, em vez de repetida no `vi.hoisted` de cada arquivo: uma variável que vale para a suíte inteira
não tem por que ser declarada cinco vezes.

## Fora de escopo

- Features de domínio. Nenhum módulo de negócio foi criado.
- `OutboxRepository` e `OutboxRelayService`. A tabela existe e está migrada; o relay tem lógica
  substancial própria (varredura com `SKIP LOCKED`, retry, DLQ) e merece plano próprio.
- Escolha da biblioteca de validação de DTO. O app não tem `class-validator` nem `zod` hoje. A regra
  estrutural entra na `CLAUDE.md` (o DTO vira VO/Model no controller; o use case nunca recebe DTO);
  a biblioteca fica para decisão própria.
- `ExceptionFilter` que traduz `StatusError` em status HTTP.
- Colapso dos exports dos packages (decisão 7).

## Riscos

- **Node 26 vs suporte declarado do Prisma (até 24.0+).** Funciona hoje; um upgrade de qualquer um
  dos dois pode quebrar sem aviso.
- **`minimumReleaseAge` do pnpm.** O workspace ganhou `1440` (24h). A regra semgrep pede `10080`
  (7 dias), valor que hoje rejeita 67 entradas já em uso do lockfile — subir exige atualizar
  dependências antes, não é troca de número.
- **A regra de import não é verificada automaticamente.** "`domain/` não importa framework" é
  convenção e revisão até existir um lint de boundaries.
- **O primeiro módulo de negócio é o teste real do layout.** Nenhum módulo existe ainda; o que está
  descrito foi validado pela camada `shared/`, não por um agregado completo.
