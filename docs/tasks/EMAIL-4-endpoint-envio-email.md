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
- Os templates e as API keys usados para testar este endpoint vêm do mecanismo de seed configurado no EMAIL-3, não de uma API de CRUD — ela ainda não existe (ver a nota "Fora de escopo" do README do diretório de tickets). Isso inclui o template de outro projeto usado no cenário de teste do `404`.

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
