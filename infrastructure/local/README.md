# Infraestrutura local

Docker Compose para desenvolvimento e testes de integração. Três arquivos:

- `docker-compose.yml` — dependências de runtime que o produto realmente usa: Postgres, Valkey (compatível com o protocolo Redis), Kafka (KRaft, sem ZooKeeper) e LocalStack (simula a API SES da AWS). Isso é o que qualquer task/serviço precisa rodando para funcionar.
- `docker-compose.tools.yml` — ferramentas de desenvolvimento, opcionais: Conduktor (UI para o Kafka), SonarQube (análise estática de qualidade/segurança), Adminer (UI para o Postgres) e k6 (teste de carga, script em TypeScript). Cada uma delas soma memória/CPU e tempo de boot, por isso ficam separadas — só sobem quando você pede. Conduktor e SonarQube reaproveitam o mesmo container Postgres do runtime (`postgres`, ver `postgres-init/`) em vez de subir um Postgres dedicado por ferramenta — só criam um database próprio nele.
- `docker-compose.observability.yml` — Grafana + Prometheus + OTel Collector + Tempo + Loki + infra exporters (Postgres/Kafka/host/containers). Separado do `docker-compose.tools.yml` porque observabilidade é sua própria categoria, e do `docker-compose.yml` porque nenhum desses componentes é uma dependência de runtime do produto.

## Comandos

Do root do monorepo (via scripts do `package.json`):

```bash
pnpm infra:up          # sobe só o runtime (postgres, valkey, kafka, localstack)
pnpm infra:down        # derruba o runtime, mantendo os volumes (dados persistem)
pnpm infra:reset       # derruba o runtime E apaga os volumes (estado limpo)
pnpm infra:logs        # segue os logs do runtime

pnpm infra:tools:up    # sobe runtime + ferramentas (conduktor, sonarqube, adminer)
pnpm infra:tools:down  # derruba runtime + ferramentas

pnpm infra:observability:up    # runtime + observabilidade (grafana, prometheus, otel-collector, tempo, loki, exporters)
pnpm infra:observability:down  # derruba runtime + observabilidade
pnpm infra:all:up              # TUDO (runtime + ferramentas + observabilidade)
pnpm infra:all:down            # derruba TUDO

pnpm infra:load-test   # roda infrastructure/local/k6/smoke.ts contra o LocalStack (default) — não é um serviço de longa duração
```

Ou diretamente com `docker compose -f infrastructure/local/docker-compose.yml [-f infrastructure/local/docker-compose.tools.yml] [-f infrastructure/local/docker-compose.observability.yml] <comando>`.

**Atenção com `infra:up` e `infra:tools:up`:** o log driver de todos os containers (runtime e tools) já vem configurado para enviar logs ao Loki (`http://localhost:3100/loki/api/v1/push`), mas o container do Loki só existe em `docker-compose.observability.yml`. Se você subir só `infra:up` ou `infra:tools:up`, os containers funcionam normalmente — o driver apenas fica tentando (e falhando) enviar logs a um Loki que não está rodando, com retry automático (`loki-retries: '5'`) e sem travar nada. Não é um erro para se preocupar, só logs que não chegam a lugar nenhum. Para os logs realmente chegarem ao Loki, suba a stack de observabilidade junto: `pnpm infra:observability:up` ou `pnpm infra:all:up`.

## Setup obrigatório: token do LocalStack

Desde 2026-03-23 o LocalStack exige um token de autenticação mesmo para os recursos gratuitos (antes era totalmente anônimo). Sem isso, `pnpm infra:up` falha rápido com uma mensagem clara em vez de o container do LocalStack ficar reiniciando em loop.

1. Crie uma conta grátis em https://app.localstack.cloud e gere um Auth Token.
2. Copie `infrastructure/local/.env.example` para `infrastructure/local/.env` e cole o token lá (`.env` já está no `.gitignore`).

## Setup obrigatório: plugin de log do Loki

`docker-compose.observability.yml` conecta o log driver do Loki em todos os containers das três compose files. Sem o plugin instalado no host, qualquer `docker compose ... up` falha:

```bash
docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
```

## Endereços e credenciais (todas de desenvolvimento, nunca usar em produção)

| Serviço               | Endereço                                                                                                      | Credenciais                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Postgres              | `localhost:5432`                                                                                              | `ruguin` / `ruguin`, db `ruguin`                                                                                   |
| Valkey (Redis)        | `localhost:6379`                                                                                              | sem senha                                                                                                          |
| Kafka                 | `localhost:9092` (host) / `kafka:29092` (outros containers)                                                   | —                                                                                                                  |
| LocalStack (SES)      | `localhost:4566`                                                                                              | `DEFAULT_REGION=us-east-1`                                                                                         |
| Conduktor (Kafka UI)  | http://localhost:8080                                                                                         | login `admin@ruguin.local` / `Ruguin#Dev1`; banco: database `conduktor-console` no Postgres acima                  |
| SonarQube             | http://localhost:9000                                                                                         | login `admin` / `admin` (padrão da imagem, troca no primeiro login); banco: database `sonarqube` no Postgres acima |
| Adminer (Postgres UI) | http://localhost:8081                                                                                         | sistema `PostgreSQL`, servidor `postgres`, mesmas credenciais do Postgres acima                                    |
| k6 (load test)        | — (CLI, `pnpm infra:load-test`)                                                                               | alvo default: LocalStack; ajuste com `K6_TARGET_URL`                                                               |
| Grafana               | http://localhost:3000                                                                                         | `admin` / `admin`                                                                                                  |
| Prometheus            | http://localhost:9090                                                                                         | —                                                                                                                  |
| Tempo                 | http://localhost:3200                                                                                         | —                                                                                                                  |
| Loki                  | http://localhost:3100                                                                                         | — (consultado via Grafana, não diretamente)                                                                        |
| OTel Collector        | `localhost:4317` (gRPC) / `localhost:4318` (HTTP) do host, `otel-collector:4317`/`:4318` de outros containers | aponte o exporter OpenTelemetry das apps para cá                                                                   |

**Por que o Kafka tem dois endereços:** o listener `PLAINTEXT` (`localhost:9092`) é para processos rodando na máquina host — é o que as apps deste monorepo (`pnpm dev`) e os testes de integração usam. O listener `INTERNAL` (`kafka:29092`) existe porque o Conduktor roda como outro container nessa mesma rede Docker, e um container não consegue alcançar outro via `localhost` — precisa do nome do serviço.

## Troubleshooting

- **SonarQube não sobe / reinicia em loop (Linux):** o Elasticsearch embutido no SonarQube exige `vm.max_map_count >= 262144` no host. Rode `sudo sysctl -w vm.max_map_count=262144` (ou torne permanente em `/etc/sysctl.conf`). No macOS/Windows com Docker Desktop isso normalmente já vem configurado na VM interna.
- **Quero começar do zero:** `pnpm infra:reset` (ou `infra:tools:down` seguido de `down -v` manual se os tools também tiverem dados que você quer descartar).
