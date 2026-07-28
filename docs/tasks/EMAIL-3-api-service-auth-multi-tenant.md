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
- [ ] Existe uma forma documentada ou automatizada (script/seed) de criar uma organização, um projeto e uma API key para desenvolvimento e testes locais — como ainda não existe uma API de CRUD para esses dados (ver a nota "Fora de escopo" do README do diretório de tickets), sem isso nenhum ticket seguinte consegue autenticar uma requisição.

## Referências

- Spec de arquitetura: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md` (seções de arquitetura e armazenamento)
