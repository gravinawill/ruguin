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
