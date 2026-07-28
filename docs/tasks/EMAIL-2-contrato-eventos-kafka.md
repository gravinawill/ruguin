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
