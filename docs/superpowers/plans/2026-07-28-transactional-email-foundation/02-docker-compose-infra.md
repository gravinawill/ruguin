# Task 2: Docker Compose dev infrastructure

**Depende de:** Task 1 (monorepo scaffolding)
**Próximas tasks que dependem desta:** 5, 6, 7, 8, 9, 10, 11 (todas as que rodam testes de integração)

## Contexto

Sobe localmente os quatro serviços de infraestrutura que o design exige: Postgres (fonte de verdade do API Service), Valkey (rate limiting + cache de auth), Kafka em modo KRaft (backbone de eventos) e LocalStack (simula a API da AWS/SES sem custo real nem risco de enviar email de verdade durante testes). Todas as tasks de teste de integração a partir daqui assumem esses endereços fixos.

Os arquivos vivem em `infrastructure/local/`, não no root do monorepo — ver `infrastructure/local/README.md` para o racional completo da pasta (`local/` vs `deploy/`) e para as ferramentas de desenvolvimento opcionais (`docker-compose.tools.yml`: Conduktor, SonarQube, Adminer), que ficam fora desta task porque nenhuma delas é uma dependência de runtime do produto.

> **Redis → Valkey:** o design original (`2026-07-28-transactional-email-api-design.md`) especifica Redis; aqui usamos Valkey (fork open-source, mesmo protocolo). Como o Valkey fala o protocolo Redis, o serviço continua se chamando `redis` no compose e `REDIS_URL=redis://localhost:6379` (Task 1) continua válido sem mudança — `ioredis` não percebe diferença. Só a imagem Docker muda; nenhuma outra task deste plano precisa ser tocada.

## Arquivos

- Criar: `infrastructure/local/docker-compose.yml`

## Interfaces

- **Produz:** Postgres em `localhost:5432` (db/user/pass `ruguin`), Valkey em `localhost:6379` (compatível com protocolo Redis), Kafka (KRaft, broker único) em `localhost:9092` para clientes no host — endereços fixos usados pelos testes de integração de todas as tasks seguintes (batem com o `.env.example` da Task 1) — e LocalStack (SES) em `localhost:4566`.

## Passos

1. **Criar `infrastructure/local/docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ruguin
      POSTGRES_PASSWORD: ruguin
      POSTGRES_DB: ruguin
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ruguin']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: valkey/valkey:9-alpine
    restart: unless-stopped
    ports:
      - '6379:6379'
    volumes:
      - valkey_data:/data
    healthcheck:
      test: ['CMD', 'valkey-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10

  kafka:
    image: apache/kafka:4.3.1
    restart: unless-stopped
    ports:
      - '9092:9092'
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,INTERNAL://0.0.0.0:29092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092,INTERNAL://kafka:29092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,INTERNAL:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: INTERNAL
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
    healthcheck:
      test: ['CMD-SHELL', '/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092']
      interval: 10s
      timeout: 10s
      retries: 10

  localstack:
    image: localstack/localstack:stable
    restart: unless-stopped
    ports:
      - '4566:4566'
    environment:
      SERVICES: ses
      DEFAULT_REGION: us-east-1

volumes:
  postgres_data:
  valkey_data:
```

> **Por que `CLUSTER_ID` não aparece aqui:** o KRaft exige que o cluster ID seja um UUID de 16 bytes codificado em base64url — exatamente 22 caracteres (o que `kafka-storage.sh random-uuid` gera). Uma string legível qualquer não passa na validação e o broker se recusa a subir. Omitindo a variável, o entrypoint da imagem oficial gera um ID válido no primeiro boot e o registra no log. Se um dia você quiser um ID fixo para reprodutibilidade, gere um de verdade e fixe-o (ex: `CLUSTER_ID: 4L6g3nShT-eMCtK--X86sw`) — nunca escreva um à mão.
>
> **Por que os dois `TRANSACTION_STATE_LOG`:** o tópico interno `__transaction_state` tem replication factor 3 e min ISR 2 por padrão, iguais ao `__consumer_offsets`. Com um único broker, ele falharia ao ser criado no momento em que alguém habilitasse um producer idempotente ou transacional. O código deste plano não usa transações, então é prevenção — mas é barata e evita um bug obscuro no futuro.
>
> **Por que existem dois listeners (`PLAINTEXT` e `INTERNAL`):** `PLAINTEXT` (`localhost:9092`) é para clientes rodando no host — as apps deste monorepo via `pnpm dev` e os testes de integração. `INTERNAL` (`kafka:29092`) existe para outros containers da mesma rede Docker (ex: o Conduktor em `docker-compose.tools.yml`), que não conseguem alcançar o container do Kafka via `localhost`. Nenhum código deste plano usa o listener `INTERNAL` — ele existe só para as ferramentas de desenvolvimento opcionais.
>
> **Por que os volumes nomeados:** sem eles, `docker compose down` apaga todos os dados do Postgres/Valkey — cada restart da stack forçaria recriar schema e reinserir seeds. Com os volumes, os dados sobrevivem a `down`/`up`; para um estado limpo de verdade (ex: antes de rodar a suíte de integração do zero), use `docker compose down -v` (ou `pnpm infra:reset`, ver Task 1).

2. **Subir a stack e verificar saúde**

Rodar (do root do monorepo): `docker compose -f infrastructure/local/docker-compose.yml up -d && sleep 5 && docker compose -f infrastructure/local/docker-compose.yml ps`
Esperado: os quatro serviços aparecem como `running`/`healthy`.

3. **Verificar que cada serviço está de fato acessível**

Rodar:
```bash
docker compose -f infrastructure/local/docker-compose.yml exec -T postgres pg_isready -U ruguin
docker compose -f infrastructure/local/docker-compose.yml exec -T redis valkey-cli ping
docker compose -f infrastructure/local/docker-compose.yml exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
curl -s http://localhost:4566/_localstack/health | grep -o '"ses": "[a-z]*"'
```
Esperado: `pg_isready` imprime `accepting connections`, valkey imprime `PONG`, o comando de tópicos do Kafka retorna (lista vazia, sem erro), e o health check do LocalStack mostra `"ses": "available"`.

4. **Commit**

```bash
git add infrastructure/ package.json
git commit -m "chore: add docker-compose dev infra (postgres, valkey, kafka, localstack)"
```
