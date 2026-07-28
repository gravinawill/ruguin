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
verificação de domínio, ou rastreamento de abertura/clique. Também não cobre
manter o status do registro de email no Postgres sincronizado com os eventos
de entrega — um "read-model" que consumisse `email.status.updated` para
atualizar a tabela `emails` fica para um ticket futuro; a prova de sucesso
usada por este conjunto de tickets é o evento Kafka, não uma coluna do banco.
Ver a seção "Fora de escopo" da spec de arquitetura para o raciocínio completo.
