# Task 2: Docker Compose dev infrastructure

**Depende de:** Task 1 (monorepo scaffolding)
**Próximas tasks que dependem desta:** 5, 6, 7, 8, 9, 10, 11 (todas as que rodam testes de integração)

## Contexto

Sobe localmente os quatro serviços de infraestrutura que o design exige: Postgres (fonte de verdade do API Service), Redis (rate limiting + cache de auth), Kafka em modo KRaft (backbone de eventos) e LocalStack (simula a API da AWS/SES sem custo real nem risco de enviar email de verdade durante testes). Todas as tasks de teste de integração a partir daqui assumem esses endereços fixos.

## Arquivos

- Criar: `docker-compose.yml`

## Interfaces

- **Produz:** Postgres em `localhost:5432` (db/user/pass `ruguin`), Redis em `localhost:6379`, Kafka (KRaft, broker único) em `localhost:9092`, LocalStack (SES) em `localhost:4566` — endereços fixos usados pelos testes de integração de todas as tasks seguintes (batem com o `.env.example` da Task 1).

## Passos

1. **Criar `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ruguin
      POSTGRES_PASSWORD: ruguin
      POSTGRES_DB: ruguin
    ports:
      - '5432:5432'
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ruguin']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10

  kafka:
    image: apache/kafka:3.8.0
    ports:
      - '9092:9092'
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1

  localstack:
    image: localstack/localstack:3
    ports:
      - '4566:4566'
    environment:
      SERVICES: ses
      DEFAULT_REGION: us-east-1
```

> **Por que `CLUSTER_ID` não aparece aqui:** o KRaft exige que o cluster ID seja um UUID de 16 bytes codificado em base64url — exatamente 22 caracteres (o que `kafka-storage.sh random-uuid` gera). Uma string legível qualquer não passa na validação e o broker se recusa a subir. Omitindo a variável, o entrypoint da imagem oficial gera um ID válido no primeiro boot e o registra no log. Se um dia você quiser um ID fixo para reprodutibilidade, gere um de verdade e fixe-o (ex: `CLUSTER_ID: 4L6g3nShT-eMCtK--X86sw`) — nunca escreva um à mão.
>
> **Por que os dois `TRANSACTION_STATE_LOG`:** o tópico interno `__transaction_state` tem replication factor 3 e min ISR 2 por padrão, iguais ao `__consumer_offsets`. Com um único broker, ele falharia ao ser criado no momento em que alguém habilitasse um producer idempotente ou transacional. O código deste plano não usa transações, então é prevenção — mas é barata e evita um bug obscuro no futuro.

2. **Subir a stack e verificar saúde**

Rodar: `docker compose up -d && sleep 5 && docker compose ps`
Esperado: os quatro serviços aparecem como `running`/`healthy` (Kafka e LocalStack não têm healthcheck definido aqui, então basta confirmar `running`).

3. **Verificar que cada serviço está de fato acessível**

Rodar:
```bash
docker compose exec -T postgres pg_isready -U ruguin
docker compose exec -T redis redis-cli ping
docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
curl -s http://localhost:4566/_localstack/health | grep -o '"ses": "[a-z]*"'
```
Esperado: `pg_isready` imprime `accepting connections`, redis imprime `PONG`, o comando de tópicos do Kafka retorna (lista vazia, sem erro), e o health check do LocalStack mostra `"ses": "available"`.

4. **Commit**

```bash
git add docker-compose.yml
git commit -m "chore: add docker-compose dev infra (postgres, redis, kafka, localstack)"
```
