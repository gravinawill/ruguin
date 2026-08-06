# Adminer

UI web leve para bancos de dados. Roda como o service `adminer` em `docker-compose.tools.yml`.

## Para que serve

Permite navegar tabelas, rodar queries SQL e inspecionar o schema do [Postgres](postgres.md) local pelo navegador, sem precisar instalar um client de banco (`psql`, DBeaver, etc.) na máquina.

## Como funciona

- Imagem `adminer:latest`.
- Sem dependências, sem volume — é só um front-end PHP que se conecta a um banco que você informa na tela de login.
- Porta exposta `8081` no host, mapeada para a `8080` interna do container.

## Como usar

```bash
pnpm infra:tools:up    # sobe runtime + ferramentas, incluindo o adminer
```

- Endereço: http://localhost:8081
- Na tela de login: sistema `PostgreSQL`, servidor `postgres` (nome do service, resolvido dentro da rede do compose), usuário/senha/database `ruguin` / `ruguin` / `ruguin` (mesmas credenciais do [Postgres](postgres.md)).
