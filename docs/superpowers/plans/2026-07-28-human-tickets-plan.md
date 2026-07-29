# Human Tickets (docs/tasks/) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write 6 human-readable, Jira/Linear-style ticket files plus an index README into `docs/tasks/`, translating the existing AI-oriented technical plan into prose a developer can read and implement from scratch — no code included.

**Architecture:** This is a documentation-writing plan, not a code plan. Each task produces one Markdown file with fixed content (drafted in full below) and no code blocks describing implementation. "Testing" a task means verifying the file exists and contains every required template section.

**Tech Stack:** Markdown only.

## Global Constraints

- Location: `docs/tasks/EMAIL-N-<slug>.md` for the six tickets, `docs/tasks/README.md` for the index.
- Every ticket follows the template from `docs/superpowers/specs/2026-07-28-human-tickets-design.md` verbatim: header metadata, Contexto e regra de negócio, O que precisa ser construído, Endpoints, Eventos Kafka, Ferramentas e bibliotecas, Regras de negócio e casos de borda, Critérios de aceite, Definição de Pronto, Referências. Omit a section only where the design doc says it's omitted (e.g. "Endpoints" on tickets with no HTTP surface).
- **No code blocks anywhere in ticket files.** This is the one rule a reviewer must reject on sight if violated — the entire point of this doc set is that the developer writes the code themselves.
- Tickets reference `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md` (architecture) in "Referências." They must NOT link to `docs/superpowers/plans/2026-07-28-transactional-email-foundation-plan.md` or the per-task briefs (those contain ready-made code and would defeat the purpose).
- Language: Portuguese (matches the design doc and the rest of this project's docs).

---

### Task 1: EMAIL-1 — Setup do monorepo e ambiente de desenvolvimento

**Files:**
- Create: `docs/tasks/EMAIL-1-setup-monorepo-infra.md`

**Interfaces:**
- Produces: the ticket referenced as a dependency by EMAIL-2, EMAIL-3, and EMAIL-5, and listed first in the README index (Task 7).

- [ ] **Step 1: Write the file**

```markdown
# [EMAIL-1] Setup do monorepo e ambiente de desenvolvimento

**Epic/Tema:** Infraestrutura
**Prioridade:** Alta (bloqueia todo o resto)
**Depende de:** nenhuma
**Bloqueia:** EMAIL-2, EMAIL-3, EMAIL-5

## Contexto e regra de negócio

Este projeto nasce como um monorepo porque vai abrigar múltiplos serviços independentes (API Service, Dispatch Worker, e futuramente outros) que precisam compartilhar código (contratos de eventos, tipos) sem duplicação. Antes de qualquer funcionalidade de negócio existir, o time precisa de um ambiente de desenvolvimento local reprodutível: banco de dados, cache, backbone de eventos e um simulador da AWS, todos rodando localmente, sem depender de credenciais reais de nuvem para desenvolver ou testar.

## O que precisa ser construído

1. Um workspace de monorepo (múltiplos pacotes/serviços num único repositório, com dependências internas entre eles resolvidas automaticamente).
2. Uma stack de infraestrutura local, definida como código, com quatro peças:
   - Um banco de dados relacional (fonte de verdade dos dados de negócio).
   - Um cache/armazenamento chave-valor (usado por outros tickets para cache de autenticação e controle de taxa de envio).
   - Um backbone de eventos (usado para desacoplar os serviços entre si).
   - Um simulador da AWS (para que o time possa testar o envio de emails sem gastar cota real nem enviar emails de verdade durante o desenvolvimento).

## Endpoints

N/A — este ticket não expõe nenhuma rota HTTP.

## Eventos Kafka

N/A diretamente — este ticket sobe o broker de eventos em si, mas os tópicos são definidos no EMAIL-2.

## Ferramentas e bibliotecas

- **pnpm (workspaces)** — gerenciador de pacotes com suporte nativo a monorepo; resolve dependências entre pacotes internos automaticamente.
- **Turborepo** — orquestra build/test entre os pacotes do monorepo, respeitando a ordem de dependência entre eles.
- **TypeScript** — linguagem usada em todos os serviços, em modo estrito.
- **Docker Compose** — define e sobe toda a infraestrutura local com um único comando.
- **Postgres** — banco de dados relacional, fonte de verdade do serviço de API.
- **Redis** — cache e controle de taxa (rate limiting).
- **Apache Kafka (modo KRaft, sem ZooKeeper)** — backbone de eventos entre os serviços.
- **LocalStack** — simula a API da AWS (especificamente o serviço de email, SES) localmente, sem custo e sem risco de enviar email de verdade durante testes.

## Regras de negócio e casos de borda

- Kafka rodando com um único broker (ambiente de desenvolvimento) precisa de configuração explícita para não depender de múltiplos brokers — por padrão, o Kafka assume um cluster de pelo menos 3 brokers para certos tópicos internos, e isso precisa ser ajustado para 1 em ambiente local, senão o broker se recusa a inicializar corretamente.
- O identificador único do cluster Kafka (quando definido manualmente) segue um formato bem específico — a recomendação é deixar a própria ferramenta gerar esse identificador automaticamente no primeiro boot, em vez de inventar um valor à mão.
- Toda a stack deve rodar em Node.js 20 ou superior, com TypeScript em modo estrito, usando módulos ES (não CommonJS) em todos os pacotes.

## Critérios de aceite

- [ ] Dado o repositório clonado, quando rodo a instalação de dependências na raiz, então ela completa sem erro.
- [ ] Dado o comando para subir a infraestrutura, quando consulto o status dos quatro serviços, então todos aparecem saudáveis/rodando (o banco aceita conexões, o cache responde a um ping, o backbone de eventos lista tópicos sem erro, e o simulador da AWS reporta o serviço de email como disponível).
- [ ] Dado o workspace configurado, quando um novo pacote é adicionado dentro das pastas de aplicações ou pacotes compartilhados, então ele é automaticamente reconhecido pelo gerenciador de workspace e pela ferramenta de build, sem configuração manual adicional.

## Definição de Pronto

- [ ] Infraestrutura local sobe com um único comando, sem passos manuais escondidos.
- [ ] Instruções de setup documentadas (como instalar dependências, subir a infraestrutura, verificar que está tudo saudável).
- [ ] Nenhuma credencial real de nuvem é necessária para desenvolver ou rodar testes localmente.

## Referências

- Spec de arquitetura: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`
```

- [ ] **Step 2: Verify all required sections are present**

Run: `grep -c '^## ' docs/tasks/EMAIL-1-setup-monorepo-infra.md`
Expected: `8` (Contexto, O que precisa ser construído, Endpoints, Eventos Kafka, Ferramentas e bibliotecas, Regras de negócio e casos de borda, Critérios de aceite, Definição de Pronto) plus confirm `## Referências` exists too — run `grep '^## ' docs/tasks/EMAIL-1-setup-monorepo-infra.md` and manually confirm all 9 headings from the template appear in order.

Run: `grep -c '```' docs/tasks/EMAIL-1-setup-monorepo-infra.md`
Expected: `0` — no code fences anywhere in the ticket body (this file itself is wrapped in one fence as part of the plan's Step 1 instruction, but the ticket file written to disk must contain zero).

- [ ] **Step 3: Commit**

```bash
git add docs/tasks/EMAIL-1-setup-monorepo-infra.md
git commit -m "docs: add EMAIL-1 human ticket (monorepo + dev infra setup)"
```

---

### Task 2: EMAIL-2 — Contrato de eventos Kafka (event-schemas)

**Files:**
- Create: `docs/tasks/EMAIL-2-contrato-eventos-kafka.md`

**Interfaces:**
- Consumes: EMAIL-1 (referenced as a dependency).
- Produces: the ticket referenced as a direct dependency by EMAIL-3 and EMAIL-5 (EMAIL-4 depends on it only transitively, through EMAIL-3).

- [ ] **Step 1: Write the file**

```markdown
# [EMAIL-2] Contrato de eventos Kafka (event-schemas)

**Epic/Tema:** Infraestrutura / Contratos
**Prioridade:** Alta
**Depende de:** EMAIL-1
**Bloqueia:** EMAIL-3, EMAIL-5

## Contexto e regra de negócio

O Kafka é o que conecta o serviço de API (que recebe os pedidos de envio) ao worker que efetivamente envia os emails — e, no futuro, a outros serviços que vão reagir a esses mesmos eventos (rastreamento de abertura/clique, entrega de webhooks para os clientes, etc). Se cada serviço definir o formato dos eventos por conta própria, uma mudança em um lado quebra o outro silenciosamente, e o bug só aparece em produção. Um contrato único e compartilhado, testado, é o que evita esse tipo de acoplamento frágil.

## O que precisa ser construído

Um pacote de código compartilhado (usado internamente pelos outros serviços do monorepo) que define, num único lugar:

1. Os nomes dos tópicos Kafka usados no sistema — ninguém deve escrever o nome de um tópico "à mão" em outro lugar do código.
2. O formato validado de cada tipo de evento — quem publica e quem consome um evento usam a mesma definição, então uma mudança que quebra o contrato é percebida na hora de compilar/testar o serviço, não em produção.

## Endpoints

N/A — este ticket não expõe nenhuma rota HTTP.

## Eventos Kafka

Este ticket **define** os eventos (não os produz nem consome — isso acontece nos tickets seguintes):

- **`email.send.requested`** (+ tópico de mensagens mortas correspondente) — representa um pedido de envio já validado, pronto para ser processado. Carrega: identificador do email, identificador da organização e do projeto donos do envio, remetente, destinatário, assunto e HTML já resolvidos (com variáveis de template já substituídas, se aplicável), e opcionalmente uma chave de idempotência.
- **`email.status.updated`** (+ tópico de mensagens mortas correspondente) — representa uma mudança de status de um email já em processamento. Carrega: identificador do email, o novo status (enviado, entregue, retornado/bounced, denunciado como spam, ou falhou), e, quando fizer sentido, o identificador da mensagem retornado pelo provedor de envio ou uma mensagem de erro.
- **`email.engagement`** (+ tópico de mensagens mortas correspondente) — reservado para eventos futuros de rastreamento de abertura e clique. Definido agora para que um serviço futuro não precise de uma mudança de contrato incompatível.

## Ferramentas e bibliotecas

- **TypeScript** — para os tipos inferidos a partir dos schemas.
- **Zod** — biblioteca de validação de esquemas em tempo de execução, usada para validar o formato de cada evento e derivar o tipo TypeScript correspondente automaticamente.

## Regras de negócio e casos de borda

- Todo timestamp presente nos eventos deve estar no formato ISO 8601 em UTC (terminando em `Z`) — não usar timestamps com offset de fuso horário.
- Cada um dos três tópicos principais tem um tópico de mensagens mortas ("dead letter queue") correspondente, para onde vão eventos que não puderam ser processados — nenhum evento deve ser simplesmente descartado silenciosamente.
- Este pacote é a única fonte de verdade para nomes de tópicos e formato de payload — qualquer outro serviço que precise publicar ou consumir um desses eventos importa as definições daqui, nunca reimplementa por conta própria.

## Critérios de aceite

- [ ] Dado um payload válido de "pedido de envio" (com todos os campos obrigatórios corretos), quando validado contra a definição, então a validação passa.
- [ ] Dado um payload de "pedido de envio" com um campo obrigatório faltando ou um endereço de email em formato inválido, quando validado, então a validação falha com um erro que identifica exatamente o campo problemático.
- [ ] Dado um payload de "status atualizado" com um valor de status fora do conjunto permitido (enviado/entregue/retornado/denunciado/falhou), quando validado, então a validação falha.

## Definição de Pronto

- [ ] Pacote disponível para ser importado pelos outros serviços do monorepo.
- [ ] Testes automatizados cobrindo pelo menos um caso válido e um caso inválido de cada tipo de evento.
- [ ] Consumido com sucesso por EMAIL-4 (publica) e EMAIL-5 (publica e consome) quando esses tickets forem implementados.

## Referências

- Spec de arquitetura: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md` (seções de arquitetura e fluxo de dados)
```

- [ ] **Step 2: Verify all required sections are present and no code blocks exist**

Run: `grep '^## ' docs/tasks/EMAIL-2-contrato-eventos-kafka.md`
Expected: all 9 headings from the template, in order.

Run: `grep -c '```' docs/tasks/EMAIL-2-contrato-eventos-kafka.md`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add docs/tasks/EMAIL-2-contrato-eventos-kafka.md
git commit -m "docs: add EMAIL-2 human ticket (Kafka event contract)"
```

---

### Task 3: EMAIL-3 — API Service: esqueleto, banco de dados e autenticação multi-tenant

**Files:**
- Create: `docs/tasks/EMAIL-3-api-service-auth-multi-tenant.md`

**Interfaces:**
- Consumes: EMAIL-1, EMAIL-2 (referenced as dependencies).
- Produces: the ticket referenced as a dependency by EMAIL-4.

- [ ] **Step 1: Write the file**

```markdown
# [EMAIL-3] API Service — esqueleto, banco de dados e autenticação multi-tenant

**Epic/Tema:** API Service
**Prioridade:** Alta
**Depende de:** EMAIL-1, EMAIL-2
**Bloqueia:** EMAIL-4

## Contexto e regra de negócio

O API Service é o plano de controle voltado para o cliente — é ele que recebe os pedidos de envio e gerencia templates, domínios e projetos. Multi-tenancy é uma decisão de arquitetura desde o dia 1: toda requisição é autenticada por uma API key que resolve para um projeto (e a organização dona daquele projeto). Cada informação armazenada (templates, emails) pertence a exatamente um projeto, e nenhuma consulta pode vazar dados entre projetos diferentes. É essa isolação que transforma a API de envio num produto SaaS de verdade, e não numa ferramenta de uso único.

## O que precisa ser construído

Um serviço HTTP com um banco de dados relacional próprio (fonte de verdade), contendo cinco tabelas: organizações, projetos, chaves de API, templates e emails. E um mecanismo de autenticação: o cliente envia uma API key no cabeçalho de autorização da requisição; o serviço identifica a chave (sem nunca armazenar a chave em texto puro) e resolve a qual projeto/organização ela pertence — usando um cache para não consultar o banco a cada requisição. Chaves desconhecidas, inválidas ou revogadas são rejeitadas.

## Endpoints

- `GET /health` → responde `200` com um corpo simples indicando que o serviço está de pé. Não exige autenticação. Usado por health checks de infraestrutura (load balancer, orquestrador de containers).
- Este ticket não adiciona nenhuma rota voltada ao cliente final além do health check — o endpoint de envio de fato é construído no EMAIL-4, em cima do mecanismo de autenticação definido aqui.

## Eventos Kafka

N/A neste ticket — a publicação de eventos acontece no EMAIL-4.

## Ferramentas e bibliotecas

- **Fastify** — framework HTTP do serviço.
- **Drizzle ORM + Postgres** — persistência dos dados e gestão de schema/migrations do banco.
- **ioredis** — cliente Redis, usado para cache do resultado de autenticação.

## Regras de negócio e casos de borda

- Uma API key nunca é armazenada em texto puro no banco — apenas um hash dela é persistido, e a autenticação compara o hash da chave recebida contra o hash armazenado.
- O resultado de uma autenticação bem-sucedida fica em cache por um tempo curto (poucos minutos), para evitar consultar o banco a cada requisição — isso significa que revogar uma chave não tem efeito instantâneo, só depois que o cache daquela chave expirar.
- Cada projeto pertence a exatamente uma organização; templates e emails pertencem a exatamente um projeto. Nenhuma consulta pode retornar ou aceitar dados de um projeto diferente do dono da API key usada na requisição.
- Este serviço é dono exclusivo dessas cinco tabelas — nenhum outro serviço do sistema (por exemplo, o Dispatch Worker do EMAIL-5) lê ou escreve nelas diretamente. Toda comunicação entre serviços acontece através de eventos Kafka, nunca por acesso direto ao banco de outro serviço.

## Critérios de aceite

- [ ] Dado um request sem cabeçalho de autenticação, quando enviado a uma rota protegida, então a resposta é `401`.
- [ ] Dado um request com uma API key válida, quando enviado a uma rota protegida, então o serviço identifica corretamente o projeto e a organização donos daquela chave.
- [ ] Dado um request com uma API key desconhecida ou revogada, quando enviado a uma rota protegida, então a resposta é `401`.
- [ ] Dado o serviço rodando, quando chamo `GET /health`, então recebo `200` sem precisar enviar nenhuma autenticação.

## Definição de Pronto

- [ ] Schema do banco de dados versionado e aplicável via migration.
- [ ] Testes automatizados cobrindo os quatro critérios de aceite acima.
- [ ] Conexões com banco e cache são encerradas corretamente quando o serviço é desligado (sem vazamento de conexões, especialmente relevante em ambiente de testes automatizados, onde muitas instâncias do serviço sobem e descem em sequência).

## Referências

- Spec de arquitetura: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md` (seções de arquitetura e armazenamento)
```

- [ ] **Step 2: Verify all required sections are present and no code blocks exist**

Run: `grep '^## ' docs/tasks/EMAIL-3-api-service-auth-multi-tenant.md`
Expected: all 9 headings from the template, in order.

Run: `grep -c '```' docs/tasks/EMAIL-3-api-service-auth-multi-tenant.md`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add docs/tasks/EMAIL-3-api-service-auth-multi-tenant.md
git commit -m "docs: add EMAIL-3 human ticket (API Service skeleton, DB, multi-tenant auth)"
```

---

### Task 4: EMAIL-4 — Endpoint de envio de email (POST /emails)

**Files:**
- Create: `docs/tasks/EMAIL-4-endpoint-envio-email.md`

**Interfaces:**
- Consumes: EMAIL-3 (referenced as a dependency).
- Produces: the ticket referenced as a dependency by EMAIL-6.

- [ ] **Step 1: Write the file**

```markdown
# [EMAIL-4] Endpoint de envio de email (POST /emails)

**Epic/Tema:** API Service
**Prioridade:** Alta
**Depende de:** EMAIL-3
**Bloqueia:** EMAIL-6

## Contexto e regra de negócio

Este é o endpoint que representa o valor central do produto — é o que outra aplicação chama para disparar um email transacional. Ele precisa ser seguro para repetir (idempotente), já que quem chama pode sofrer timeout e reenviar a mesma requisição. E precisa desacoplar "aceitar o pedido" de "efetivamente enviar o email": o trabalho deste endpoint é validar, resolver o conteúdo final, persistir o pedido e publicar um evento — ele nunca chama a AWS SES diretamente (isso é responsabilidade do EMAIL-5, de forma assíncrona).

## O que precisa ser construído

Uma rota que aceita ou uma referência a um template salvo (com variáveis para substituir) ou o assunto/HTML direto, resolve o conteúdo final do email, grava um registro do pedido de envio, e publica um evento para que o Dispatch Worker processe de forma assíncrona.

## Endpoints

- `POST /emails` (autenticado por API key, herdando o mecanismo do EMAIL-3) — o corpo da requisição aceita `from`, `to`, e OU `templateId` + `variables` OU `subject` + `html` diretamente. Um cabeçalho opcional `Idempotency-Key` pode ser enviado para tornar a chamada segura contra reenvio. Resposta de sucesso: `202` com o identificador do email criado e status `queued`.
- Respostas de erro esperadas: `400` se o corpo não trouxer nem `templateId` nem `subject`+`html`; `404` se o `templateId` informado não existir ou pertencer a outro projeto; `401` herdado do mecanismo de autenticação (EMAIL-3).

## Eventos Kafka

- **Produz** `email.send.requested` — publicado depois que o email já foi validado, persistido, e o conteúdo final (assunto e HTML) já foi resolvido (template renderizado com as variáveis informadas, se for o caso).

## Ferramentas e bibliotecas

- **Fastify + Zod** — validação do corpo da requisição.
- **Drizzle ORM** — leitura de templates e escrita na tabela de emails.
- **KafkaJS** — publicação do evento de pedido de envio, usando o contrato definido no EMAIL-2.

## Regras de negócio e casos de borda

- **Idempotência:** se o cliente reenviar a mesma requisição com o mesmo `Idempotency-Key` (por exemplo, depois de um timeout), o endpoint deve retornar o mesmo identificador de email da primeira chamada, sem criar um segundo registro nem publicar um segundo evento. Essa garantia precisa se sustentar mesmo quando duas requisições concorrentes chegam ao mesmo tempo com a mesma chave — a garantia final precisa vir de uma restrição no próprio banco de dados, não apenas de uma checagem feita em memória antes de gravar (checar e depois gravar, em dois passos separados, deixa uma janela onde duas requisições simultâneas passam pela checagem antes de qualquer uma delas gravar).
- **Renderização de template:** variáveis no formato `{{nome}}` dentro do template são substituídas pelos valores informados no pedido. Se o template referenciar uma variável que não foi informada na requisição, o pedido deve falhar de forma explícita — nunca silenciosamente enviar um email com um `{{nome}}` literal no meio do texto.
- **Isolamento multi-tenant:** um `templateId` só pode ser usado se pertencer ao mesmo projeto dono da API key usada na requisição — não é possível referenciar o template de outro projeto, mesmo sabendo o identificador exato dele.
- Este endpoint nunca chama a AWS SES diretamente — ele só grava o pedido no banco e publica o evento. Quem efetivamente envia o email é o Dispatch Worker (EMAIL-5), de forma assíncrona e desacoplada.

## Critérios de aceite

- [ ] Dado um pedido válido com `templateId` e variáveis, quando enviado, então o email é persistido já com o assunto/HTML renderizados, e um evento de pedido de envio é publicado contendo esse conteúdo final.
- [ ] Dado um pedido sem `templateId` nem `subject`+`html`, quando enviado, então a resposta é `400`.
- [ ] Dado dois pedidos concorrentes com o mesmo `Idempotency-Key`, quando ambos chegam ao mesmo tempo, então só um registro é criado no banco e os dois pedidos recebem o mesmo identificador na resposta.
- [ ] Dado um `templateId` que pertence a outro projeto, quando referenciado, então a resposta é `404` (nunca um `200` com dados de outro projeto).

## Definição de Pronto

- [ ] Testes automatizados cobrindo os quatro critérios de aceite acima, incluindo o cenário de concorrência na idempotência.
- [ ] O evento publicado é validado contra o contrato definido no EMAIL-2 antes de ser enviado ao Kafka.

## Referências

- Spec de arquitetura: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md` (fluxo de dados e tratamento de erros — seção de idempotência)
```

- [ ] **Step 2: Verify all required sections are present and no code blocks exist**

Run: `grep '^## ' docs/tasks/EMAIL-4-endpoint-envio-email.md`
Expected: all 9 headings from the template, in order.

Run: `grep -c '```' docs/tasks/EMAIL-4-endpoint-envio-email.md`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add docs/tasks/EMAIL-4-endpoint-envio-email.md
git commit -m "docs: add EMAIL-4 human ticket (POST /emails endpoint)"
```

---

### Task 5: EMAIL-5 — Dispatch Worker: consumo de eventos e envio via SES

**Files:**
- Create: `docs/tasks/EMAIL-5-dispatch-worker-ses.md`

**Interfaces:**
- Consumes: EMAIL-1, EMAIL-2 (referenced as dependencies).
- Produces: the ticket referenced as a dependency by EMAIL-6.

- [ ] **Step 1: Write the file**

```markdown
# [EMAIL-5] Dispatch Worker — consumo de eventos e envio via SES

**Epic/Tema:** Dispatch Worker
**Prioridade:** Alta
**Depende de:** EMAIL-1, EMAIL-2
**Bloqueia:** EMAIL-6

## Contexto e regra de negócio

É aqui que o envio de fato acontece, desacoplado do pedido HTTP original. Rodar isso como um consumidor separado significa que um pico de pedidos de envio não sobrecarrega a API, e uma AWS SES lenta ou com limite de taxa atingido não faz o cliente da API esperar. O Dispatch Worker precisa respeitar o limite de envio da conta AWS SES (compartilhado entre todas as instâncias do worker, se houver mais de uma rodando) e precisa ser resiliente às garantias de entrega do Kafka (uma mensagem pode ser entregue mais de uma vez).

## O que precisa ser construído

Um worker que roda em segundo plano, se inscreve no fluxo de eventos de "pedido de envio", respeita um limite de taxa compartilhado antes de chamar a AWS SES, chama a SES para efetivamente enviar o email, e publica um evento de status com o resultado (enviado ou falhou) para que o resto do sistema saiba o que aconteceu.

## Endpoints

N/A — este worker não expõe nenhuma rota HTTP.

## Eventos Kafka

- **Consome** `email.send.requested`.
- **Produz** `email.status.updated` com status "enviado" (junto com o identificador de mensagem retornado pela SES) em caso de sucesso, ou "falhou" (junto com uma mensagem de erro) em caso de falha.
- **Produz** na fila de mensagens mortas de `email.send.requested` quando uma mensagem chega em formato inesperado ou corrompido — isso não pode travar o processamento das mensagens seguintes.

## Ferramentas e bibliotecas

- **KafkaJS** — consumo do evento de pedido de envio e produção do evento de status.
- **ioredis** — controle de taxa compartilhado entre instâncias do worker, e controle de deduplicação de processamento.
- **AWS SDK v3 (`@aws-sdk/client-ses`)** — chamada ao serviço de envio de email. Em desenvolvimento/teste, aponta para o simulador local (LocalStack) definido no EMAIL-1; em produção, aponta para a AWS real.

## Regras de negócio e casos de borda

- **Limite de taxa compartilhado:** a conta AWS SES tem um limite de envios por segundo. Esse limite é compartilhado entre TODAS as instâncias do worker, caso mais de uma esteja rodando — então o controle de taxa precisa viver num lugar compartilhado (Redis), não na memória de cada processo isoladamente. E o cálculo do tempo usado nesse controle precisa vir de uma fonte de tempo compartilhada (o próprio Redis), não do relógio de cada máquina — relógios de máquinas diferentes podem estar levemente dessincronizados, e isso corromperia o cálculo do limite se cada instância confiasse no próprio relógio.
- **Mensagem malformada não pode travar a fila:** o Kafka garante entrega "pelo menos uma vez" — se o worker falhar ao processar uma mensagem sem confirmar o recebimento, a mesma mensagem volta a ser entregue depois. Uma mensagem genuinamente corrompida ou malformada nunca vai processar com sucesso, então ela precisa ser desviada para uma fila de mensagens mortas em vez de ser reentregue indefinidamente e travar todas as mensagens que vêm depois dela na mesma partição.
- **Proteção contra envio duplicado:** como o Kafka pode entregar a mesma mensagem mais de uma vez (por exemplo, se o worker cair logo depois de enviar o email pela SES, mas antes de confirmar que terminou de processar aquela mensagem), o worker precisa de um mecanismo que impeça enviar o mesmo email duas vezes pela SES quando isso acontecer.
- **Fora de escopo deste ticket:** nova tentativa automática com espera crescente (backoff exponencial) para falhas transitórias da própria SES — hoje, uma falha de envio é reportada uma única vez como "falhou", sem novas tentativas automáticas. Isso fica para um ticket de hardening futuro, e não deve ser confundido com um esquecimento.

## Critérios de aceite

- [ ] Dado um evento de pedido de envio válido, quando consumido, então a AWS SES é chamada e um evento de status "enviado" é publicado.
- [ ] Dado que o limite de taxa da conta SES foi atingido, quando uma nova mensagem chega, então o worker aguarda em vez de descartar a mensagem ou estourar o limite da conta.
- [ ] Dado um evento malformado (formato inválido ou faltando campos obrigatórios), quando consumido, então ele vai para a fila de mensagens mortas, e o processamento das mensagens seguintes continua normalmente.
- [ ] Dado que a mesma mensagem é entregue duas vezes pelo Kafka, quando processada pela segunda vez, então o email NÃO é enviado de novo pela SES.

## Definição de Pronto

- [ ] Testes automatizados cobrindo os quatro critérios de aceite acima.
- [ ] Testes validados contra um simulador de SES (LocalStack), sem depender de credenciais reais da AWS.

## Referências

- Spec de arquitetura: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md` (tratamento de erros — limite de taxa, fila de mensagens mortas, deduplicação)
```

- [ ] **Step 2: Verify all required sections are present and no code blocks exist**

Run: `grep '^## ' docs/tasks/EMAIL-5-dispatch-worker-ses.md`
Expected: all 9 headings from the template, in order.

Run: `grep -c '```' docs/tasks/EMAIL-5-dispatch-worker-ses.md`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add docs/tasks/EMAIL-5-dispatch-worker-ses.md
git commit -m "docs: add EMAIL-5 human ticket (Dispatch Worker + SES)"
```

---

### Task 6: EMAIL-6 — Teste ponta a ponta do pipeline de envio

**Files:**
- Create: `docs/tasks/EMAIL-6-teste-e2e-pipeline-envio.md`

**Interfaces:**
- Consumes: EMAIL-4, EMAIL-5 (referenced as dependencies).
- Produces: nothing consumed further — the final ticket in the dependency chain, listed last in the README index (Task 7).

- [ ] **Step 1: Write the file**

```markdown
# [EMAIL-6] Teste ponta a ponta do pipeline de envio

**Epic/Tema:** Qualidade / Validação
**Prioridade:** Média
**Depende de:** EMAIL-4, EMAIL-5
**Bloqueia:** nenhuma

## Contexto e regra de negócio

Cada peça do sistema (API Service, Dispatch Worker) pode estar individualmente correta e a integração entre elas ainda assim estar quebrada — formato de evento errado, nome de tópico errado, uma suposição de tempo que não se sustenta na prática. Este ticket é a prova de que o caminho completo realmente funciona junto, de ponta a ponta, e não apenas isoladamente.

## O que precisa ser construído

Um teste automatizado (ou, na ausência de automação, um roteiro de verificação manual documentado) que dispara uma chamada real ao endpoint de envio e comprova, através do sistema real rodando (não substituído por simulações internas), que o email chega até a chamada à AWS SES e que o status final é corretamente refletido de volta no sistema.

## Endpoints

Usa o `POST /emails` (construído no EMAIL-4) como ponto de entrada — este ticket não expõe nenhuma rota nova.

## Eventos Kafka

Observa o evento de status (produzido pelo EMAIL-5) como prova de que o pipeline completo funcionou.

## Ferramentas e bibliotecas

As mesmas ferramentas dos tickets anteriores, rodando juntas (API Service + Dispatch Worker + a infraestrutura definida no EMAIL-1) — nenhuma ferramenta nova é introduzida por este ticket.

## Regras de negócio e casos de borda

- O teste precisa rodar contra a infraestrutura real definida no EMAIL-1 (banco de dados, cache, backbone de eventos, simulador de SES) — não contra versões simuladas/substituídas dessas dependências, senão a integração real nunca é de fato validada.
- Este ticket comprova o caminho de sucesso ponta a ponta. Cenários de falha (SES fora do ar, mensagem malformada, limite de taxa estourado, etc.) já têm cobertura própria dentro do EMAIL-5 e não precisam ser repetidos aqui.

## Critérios de aceite

- [ ] Dado o sistema completo rodando (API Service, Dispatch Worker e toda a infraestrutura), quando chamo o endpoint de envio com um pedido válido, então recebo uma resposta de sucesso com um identificador de email.
- [ ] Dado o identificador retornado, quando aguardo o processamento assíncrono, então observo um evento de status para aquele identificador com status "enviado" e um identificador de mensagem da SES presente.

## Definição de Pronto

- [ ] Teste automatizado (ou roteiro documentado) reproduzível por qualquer pessoa do time, sem passos manuais escondidos além de subir a infraestrutura local.

## Referências

- Spec de arquitetura: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md` (visão geral do fluxo de dados)
```

- [ ] **Step 2: Verify all required sections are present and no code blocks exist**

Run: `grep '^## ' docs/tasks/EMAIL-6-teste-e2e-pipeline-envio.md`
Expected: all 9 headings from the template, in order.

Run: `grep -c '```' docs/tasks/EMAIL-6-teste-e2e-pipeline-envio.md`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add docs/tasks/EMAIL-6-teste-e2e-pipeline-envio.md
git commit -m "docs: add EMAIL-6 human ticket (end-to-end pipeline test)"
```

---

### Task 7: Índice README dos tickets

**Files:**
- Create: `docs/tasks/README.md`

**Interfaces:**
- Consumes: the file paths and titles of Tasks 1–6 (must match exactly what those tasks created).
- Produces: nothing consumed further — this is the entry point a developer opens first.

- [ ] **Step 1: Write the file**

```markdown
# Tickets — SaaS de Email Transacional

Este diretório contém tickets no estilo Jira/Linear para o núcleo transacional do
SaaS de envio de email, escritos para um desenvolvedor humano implementar por
conta própria — sem código pronto, ao contrário do plano técnico em
`docs/superpowers/plans/`, que foi escrito para execução por IA.

Leia primeiro a spec de arquitetura: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`.

## Tickets, em ordem de dependência

| ID | Título | Depende de |
|---|---|---|
| [EMAIL-1](EMAIL-1-setup-monorepo-infra.md) | Setup do monorepo e ambiente de desenvolvimento | nenhuma |
| [EMAIL-2](EMAIL-2-contrato-eventos-kafka.md) | Contrato de eventos Kafka (event-schemas) | EMAIL-1 |
| [EMAIL-3](EMAIL-3-api-service-auth-multi-tenant.md) | API Service — esqueleto, banco de dados e autenticação multi-tenant | EMAIL-1, EMAIL-2 |
| [EMAIL-4](EMAIL-4-endpoint-envio-email.md) | Endpoint de envio de email (`POST /emails`) | EMAIL-3 |
| [EMAIL-5](EMAIL-5-dispatch-worker-ses.md) | Dispatch Worker — consumo de eventos e envio via SES | EMAIL-1, EMAIL-2 |
| [EMAIL-6](EMAIL-6-teste-e2e-pipeline-envio.md) | Teste ponta a ponta do pipeline de envio | EMAIL-4, EMAIL-5 |

## Paralelização possível

Depois que EMAIL-1 e EMAIL-2 estiverem prontos, EMAIL-3 e EMAIL-5 podem ser
implementados em paralelo por desenvolvedores diferentes — um cuidando do
serviço de API, outro do worker de envio. EMAIL-4 só pode começar depois de
EMAIL-3, e EMAIL-6 fecha o trabalho depois que EMAIL-4 e EMAIL-5 estiverem
ambos prontos.

## Escopo

Este conjunto de tickets cobre só o núcleo transacional (enviar um email via
API até ele efetivamente sair pela AWS SES). Não cobre: campanhas de
marketing, CRUD de gestão de conta (orgs/projetos/API keys/templates via
API — os tickets assumem esses dados semeados diretamente no banco), anexos,
verificação de domínio, ou rastreamento de abertura/clique. Ver a seção
"Fora de escopo" da spec de arquitetura para o raciocínio completo.
```

- [ ] **Step 2: Verify the index links match the files created in Tasks 1–6**

Run: `ls docs/tasks/*.md`
Expected: exactly 7 files — `README.md` and `EMAIL-1-setup-monorepo-infra.md` through `EMAIL-6-teste-e2e-pipeline-envio.md`. Cross-check each filename against the corresponding link in `README.md`'s table — they must match exactly (a typo'd filename in a Markdown link silently 404s, it doesn't error).

- [ ] **Step 3: Commit**

```bash
git add docs/tasks/README.md
git commit -m "docs: add docs/tasks index README"
```

---

## Verification

After Task 7:

1. `ls docs/tasks/` shows 7 files: the index and the 6 tickets.
2. `grep -rc '```' docs/tasks/*.md` — every file reports `0` (the one non-negotiable rule: no code anywhere in this doc set).
3. Every "Depende de" / "Bloqueia" reference in every ticket points to a real ticket ID that exists in this same directory (no dangling references) — spot-check by reading each ticket's header against the table in `README.md`.
4. A developer with zero prior context on this project can open `docs/tasks/README.md`, follow a link, and understand what to build, which endpoints/events are involved, which tools to use, and how to know they're done — without ever opening `docs/superpowers/plans/`.
