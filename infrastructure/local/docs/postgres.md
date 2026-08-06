# Postgres

Banco relacional principal do produto. Roda como o service `postgres` em `docker-compose.yml`.

## Para que serve

É o banco de dados de runtime do core-server (e dos demais serviços que vierem a precisar de Postgres). Também é reaproveitado por ferramentas de dev — Conduktor e SonarQube (`docker-compose.tools.yml`) guardam seus próprios estados em databases separados dentro desse mesmo container, em vez de cada ferramenta subir um Postgres dedicado.

## Como funciona

- Imagem `postgres:16-alpine`.
- Sobe com `shared_preload_libraries=pg_stat_statements` e `pg_stat_statements.track=all` — estatísticas de execução de query ficam disponíveis desde o boot, úteis para investigar queries lentas sem precisar reiniciar o container depois.
- Usuário/senha/database: `ruguin` / `ruguin` / `ruguin`.
- No primeiro boot, `postgres-init/*.sh` roda automaticamente (mecanismo padrão da imagem oficial, via `/docker-entrypoint-initdb.d`) e cria os databases extras usados pelas outras ferramentas (`conduktor-console`, `sonarqube`) e a role `postgres_exporter` usada pela observabilidade. Esses scripts são no-op se você nunca subir `docker-compose.tools.yml`/`docker-compose.observability.yml`.
- Healthcheck via `pg_isready`.

## Como usar

```bash
pnpm infra:up          # sobe o postgres junto com o resto do runtime
```

- Endereço: `localhost:5432`.
- Credenciais: `ruguin` / `ruguin`, database `ruguin`.
- Para inspecionar via UI, suba o [Adminer](adminer.md) (`pnpm infra:tools:up`).
- `pnpm infra:reset` derruba o runtime **e apaga o volume** `postgres_data` — use quando quiser um estado limpo.
