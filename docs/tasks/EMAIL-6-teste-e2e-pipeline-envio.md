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
