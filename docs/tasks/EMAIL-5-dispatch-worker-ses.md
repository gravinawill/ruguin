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
