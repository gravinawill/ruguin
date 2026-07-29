# Task 1: Postgres — role de monitoramento + `pg_stat_statements`

**Depende de:** `infrastructure/local/docker-compose.yml` e `infrastructure/local/postgres-init/` já existentes (criados no plano de docker-compose infra).
**Próximas tasks que dependem desta:** 6 (`postgres_exporter` usa a role criada aqui)

## Contexto

O `postgres_exporter` (Task 6) não deve autenticar como `ruguin` — esse usuário é superusuário da instância e já é compartilhado por Conduktor/SonarQube/Adminer (ver nota de segurança no design de 2026-07-29). Esta task cria uma role dedicada, só leitura de estatísticas (`pg_monitor`, role embutida do Postgres desde a versão 10 — nunca precisa de superuser pra isso), e habilita `pg_stat_statements` para métricas por query, não só agregadas por banco.

## Arquivos

- Modificar: `infrastructure/local/docker-compose.yml` (serviço `postgres`)
- Criar: `infrastructure/local/postgres-init/02-observability-setup.sh`

## Interfaces

- **Produz:** role Postgres `postgres_exporter` (senha `postgres_exporter`, role `pg_monitor` concedida) e extensão `pg_stat_statements` habilitada no banco `ruguin` — usados pela Task 6 via `DATA_SOURCE_NAME=postgresql://postgres_exporter:postgres_exporter@postgres:5432/ruguin?sslmode=disable`.

## Passos

- [ ] **Passo 1: Habilitar `pg_stat_statements` no boot do Postgres**

Editar o serviço `postgres` em `infrastructure/local/docker-compose.yml`, adicionando um `command:` (a extensão precisa da lib pré-carregada no boot do servidor — não dá pra habilitar depois via `CREATE EXTENSION` sozinho):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    command:
      - 'postgres'
      - '-c'
      - 'shared_preload_libraries=pg_stat_statements'
      - '-c'
      - 'pg_stat_statements.track=all'
    environment:
      POSTGRES_USER: ruguin
      POSTGRES_PASSWORD: ruguin
      POSTGRES_DB: ruguin
    # ... resto do serviço (ports, volumes, healthcheck) inalterado
```

- [ ] **Passo 2: Criar a role e a extensão**

Criar `infrastructure/local/postgres-init/02-observability-setup.sh`:

```bash
#!/bin/sh
set -e

# Roda só no primeiro boot do container postgres (volume vazio). Cria a role só-leitura
# postgres_exporter (Task 6, infrastructure/local/docker-compose.observability.yml) --
# nunca o superuser ruguin -- e habilita pg_stat_statements no banco ruguin pra métricas
# por query. Depende de shared_preload_libraries=pg_stat_statements já setado via o
# `command:` do serviço postgres (docker-compose.yml) -- sem isso o CREATE EXTENSION falha.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres_exporter') THEN
	    CREATE USER postgres_exporter WITH PASSWORD 'postgres_exporter';
	  END IF;
	END
	\$\$;
	GRANT pg_monitor TO postgres_exporter;
	GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO postgres_exporter;
	CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EOSQL
```

```bash
chmod +x infrastructure/local/postgres-init/02-observability-setup.sh
```

- [ ] **Passo 3: Recriar o Postgres do zero e verificar**

`shared_preload_libraries` só é lido no boot, e scripts de `postgres-init/` só rodam com o volume vazio — por isso precisa recriar:

```bash
docker compose -f infrastructure/local/docker-compose.yml down
docker volume rm ruguin_postgres_data
docker compose -f infrastructure/local/docker-compose.yml up -d postgres
```

Rodar:
```bash
docker compose -f infrastructure/local/docker-compose.yml exec -T postgres psql -U ruguin -d ruguin -c "SHOW shared_preload_libraries;"
docker compose -f infrastructure/local/docker-compose.yml exec -T postgres psql -U ruguin -d ruguin -c "\du postgres_exporter"
PGPASSWORD=postgres_exporter docker compose -f infrastructure/local/docker-compose.yml exec -T postgres psql -U postgres_exporter -d ruguin -c "SELECT count(*) FROM pg_stat_statements;"
```
Esperado: a primeira mostra `pg_stat_statements` na lista; a segunda mostra a role `postgres_exporter` com o atributo `pg_monitor` nos memberships; a terceira roda sem erro de permissão (pode retornar `0` linhas, tudo bem, o que importa é não dar erro de acesso negado).

- [ ] **Passo 4: Commit**

```bash
git add infrastructure/local/docker-compose.yml infrastructure/local/postgres-init/02-observability-setup.sh
git commit -m "feat(observability): add postgres_exporter monitoring role and pg_stat_statements"
```
