# SonarQube

Análise estática de qualidade e segurança de código. Roda como o service `sonarqube` em `docker-compose.tools.yml`.

## Para que serve

Roda análises de qualidade (code smells, duplicação, cobertura) e segurança (vulnerabilidades, hotspots) sobre o código do monorepo, localmente — o mesmo tipo de check que o pipeline de CI ("ci: wire ses-webhook-ingestor and event-schemas coverage into SonarCloud") reporta, mas disponível para rodar e explorar antes de abrir um PR.

## Como funciona

- Imagem `sonarqube:community` — tag `community` acompanha os releases contínuos da Community Build; a alternativa `lts-community` fica travada na linha legada 9.9 LTS, com suporte mais antigo a linguagens/analisadores.
- Depende de `postgres` estar `healthy` antes de subir.
- Guarda seu estado no database `sonarqube`, dentro do mesmo container Postgres do runtime (criado automaticamente no primeiro boot) — não sobe um Postgres dedicado.
- Precisa de `ulimits` elevados (`nofile: 131072`, `nproc: 8192`) porque embute um Elasticsearch internamente.
- Healthcheck consulta `/api/system/status` até o status virar `"UP"` (`start_period: 90s` — o boot é lento).
- Dados persistidos em três volumes: `sonarqube_data`, `sonarqube_extensions`, `sonarqube_logs`.

## Como usar

```bash
pnpm infra:tools:up    # sobe runtime + ferramentas, incluindo o sonarqube
```

- Endereço: http://localhost:9000
- Login: `admin` / `admin` (senha padrão da imagem — troca obrigatória no primeiro login).

### Troubleshooting

- **Não sobe / reinicia em loop (Linux):** o Elasticsearch embutido exige `vm.max_map_count >= 262144` no host — rode `sudo sysctl -w vm.max_map_count=262144` (ou torne permanente em `/etc/sysctl.conf`). No macOS/Windows com Docker Desktop isso normalmente já vem configurado na VM interna.
