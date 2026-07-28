# Tickets Humanos (estilo Jira/Linear) — Design

**Data:** 2026-07-28
**Status:** Aprovado para plano de execução
**Escopo:** Formato e conteúdo de um novo conjunto de documentos em `docs/tasks/`, derivado da spec e do plano técnico já existentes para o núcleo transacional do SaaS de email.

## Contexto e objetivo

Já existem dois artefatos para o mesmo trabalho:

- `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md` — a spec de arquitetura aprovada.
- `docs/superpowers/plans/2026-07-28-transactional-email-foundation-plan.md` + `docs/superpowers/plans/2026-07-28-transactional-email-foundation/*.md` — um plano de implementação de 11 tasks técnicas, com código TypeScript completo em cada passo, escrito para um subagente de IA implementar mecanicamente.

Esse plano técnico não serve para dar a um desenvolvedor humano: ele já vem com a solução pronta para copiar, sem espaço para a pessoa entender a regra de negócio e programar por conta própria. O objetivo deste design é um conjunto **paralelo** de documentos — tickets no estilo Jira/Linear, escritos como um tech lead que abre uma tarefa para um desenvolvedor: explica o contexto, a regra de negócio, quais endpoints/eventos/ferramentas entram em jogo, e os critérios de aceite — mas **sem nenhum trecho de código**, para que a implementação seja de fato do desenvolvedor.

## Fora de escopo

- Não substitui os documentos técnicos existentes em `docs/superpowers/plans/` — ambos coexistem, com públicos diferentes (IA executora vs. desenvolvedor humano).
- Não cobre marketing/campanhas — mesmo escopo da spec original (núcleo transacional).
- Não inclui estimativa de esforço (pontos/horas) — fica a critério do time no momento de planejar a sprint.

## Estrutura dos tickets

Os tickets reagrupam as 11 tasks técnicas por entrega vertical (mais próximo de como um tech lead quebraria o trabalho de verdade), em vez de manter a granularidade passo-a-passo pensada para execução por IA:

| ID | Título | Tasks técnicas cobertas |
|---|---|---|
| EMAIL-1 | Setup do monorepo e ambiente de desenvolvimento | 1, 2 |
| EMAIL-2 | Contrato de eventos Kafka (event-schemas) | 3 |
| EMAIL-3 | API Service — esqueleto, banco de dados e autenticação multi-tenant | 4, 5, 6 |
| EMAIL-4 | Endpoint de envio de email (`POST /emails`) | 7, 8 |
| EMAIL-5 | Dispatch Worker — consumo de eventos e envio via SES | 9, 10 |
| EMAIL-6 | Teste ponta a ponta do pipeline de envio | 11 |

Dependências entre tickets seguem a mesma ordem da tabela: EMAIL-3 depende de EMAIL-1 e EMAIL-2; EMAIL-4 depende de EMAIL-3; EMAIL-5 depende de EMAIL-2 e EMAIL-1; EMAIL-6 depende de EMAIL-4 e EMAIL-5. Isso permite atribuir EMAIL-3 e EMAIL-5 a desenvolvedores diferentes em paralelo assim que EMAIL-1/EMAIL-2 estiverem prontos.

## Template de cada ticket

Cada arquivo em `docs/tasks/` segue esta estrutura fixa:

```markdown
# [EMAIL-N] Título

**Epic/Tema:** ...
**Prioridade:** ...
**Depende de:** EMAIL-X, EMAIL-Y (ou "nenhuma")
**Bloqueia:** EMAIL-Z (ou "nenhuma")

## Contexto e regra de negócio

Prosa explicando o "porquê" — a motivação de negócio, como essa peça se encaixa no
sistema maior, e qualquer regra de negócio que rege o comportamento (ex: por que
idempotência importa, por que multi-tenancy isola dados por projeto).

## O que precisa ser construído

Descrição funcional do comportamento esperado — o que o sistema deve fazer,
não como o código deve ser escrito.

## Endpoints

Para tickets que expõem HTTP: método, path, o que o request precisa conter,
o formato da resposta (em prosa ou exemplo JSON), autenticação exigida.
Omitido em tickets que não expõem endpoints.

## Eventos Kafka

Para tickets que produzem/consomem eventos: nome do tópico, se produz ou
consome, o que o payload precisa conter. Omitido em tickets sem Kafka.

## Ferramentas e bibliotecas

Lista do que usar e por quê (ex: "Fastify — framework HTTP", "Drizzle ORM +
Postgres — persistência", "ioredis — cache e rate limiting", "KafkaJS —
produção/consumo de eventos", "AWS SDK v3 (@aws-sdk/client-ses) — envio via
SES"). Nomeia a ferramenta e o papel dela, nunca código de uso.

## Regras de negócio e casos de borda

Lista dos comportamentos não-óbvios que o desenvolvedor precisa tratar
(ex: idempotência via header, isolamento multi-tenant, rate limiting
compartilhado, deduplicação de eventos, mensagens malformadas).

## Critérios de aceite

Checklist no formato "Dado / Quando / Então" ou lista de comportamentos
verificáveis.

## Definição de Pronto

Checklist do que precisa estar verdadeiro para considerar o ticket concluído
(testes automatizados cobrindo os critérios de aceite, código revisado, etc).

## Referências

Link para a spec de arquitetura (`docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`).
Não linka para o plano técnico com código pronto (`docs/superpowers/plans/...`) —
o ponto deste ticket é o desenvolvedor implementar por conta própria.
```

**Regra inegociável do template:** nenhum ticket contém trechos de código. Nomes de endpoints, tópicos Kafka, tabelas de banco de dados, variáveis de ambiente e bibliotecas são fatos de arquitetura (podem aparecer), mas função/rota/handler implementados não podem.

## Local e nomenclatura dos arquivos

`docs/tasks/EMAIL-1-setup-monorepo-infra.md` até `docs/tasks/EMAIL-6-teste-e2e-pipeline-envio.md`, mais um `docs/tasks/README.md` de índice listando os 6 tickets, suas dependências e o link para a spec de arquitetura.

## Decisões em aberto para a próxima fase (não bloqueiam este design)

- Numeração/prefixo de projeto (`EMAIL-`) é uma convenção local, não uma integração real com Jira/Linear — se o time depois importar isso para uma ferramenta real, a numeração pode mudar.
- Sem estimativa de esforço nos tickets, conforme decidido acima.
