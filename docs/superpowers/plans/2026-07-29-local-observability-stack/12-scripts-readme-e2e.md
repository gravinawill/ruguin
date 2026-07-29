# Task 12: Scripts, README, verificação ponta a ponta

**Depende de:** todas as tasks anteriores (1-11)
**Próximas tasks que dependem desta:** nenhuma — fecha o plano

## Contexto

Última task: comandos `pnpm` pra subir a stack de observabilidade (sozinha ou junto com core + tools), documentação em `infrastructure/local/README.md` (que já documenta o resto de `infrastructure/local/` desde o plano de docker-compose infra), e uma verificação final de que as 12 tasks juntas realmente funcionam de ponta a ponta.

## Arquivos

- Modificar: `package.json` (raiz do monorepo)
- Modificar: `infrastructure/local/README.md`

## Interfaces

- **Consome:** todos os serviços das Tasks 1-11.
- **Produz:** `pnpm infra:observability:up`/`:down`, `pnpm infra:all:up`/`:down` — comandos que qualquer task futura (incluindo as Tasks 4+ do plano de email transacional) pode assumir que existem.

## Passos

- [ ] **Passo 1: Adicionar os scripts no `package.json` raiz**

Editar o bloco `scripts` de `package.json`, mantendo ordem alfabética (mesma convenção já usada nos scripts `infra:*` existentes):

```json
"infra:all:down": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml down",
"infra:all:up": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml up -d",
"infra:observability:down": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml down",
"infra:observability:up": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d",
```

- [ ] **Passo 2: Atualizar `infrastructure/local/README.md`**

No parágrafo que descreve os arquivos do diretório, adicionar a menção ao terceiro arquivo compose:

```markdown
- `docker-compose.observability.yml` — Grafana + Prometheus + OTel Collector + Tempo + Loki + exporters de infra (Postgres/Kafka/host/containers). Separado de `docker-compose.tools.yml` porque observabilidade é uma categoria própria, e de `docker-compose.yml` porque nenhum destes componentes é uma dependência de runtime do produto.
```

Na seção de comandos, adicionar:

```markdown
pnpm infra:observability:up    # sobe runtime + observabilidade (grafana, prometheus, otel-collector, tempo, loki, exporters)
pnpm infra:observability:down  # derruba runtime + observabilidade
pnpm infra:all:up              # sobe TUDO (runtime + tools + observability)
pnpm infra:all:down            # derruba TUDO
```

Na seção de setup obrigatório, adicionar (junto ao já existente sobre o token do LocalStack):

```markdown
## Setup obrigatório: plugin de log do Loki

`docker-compose.observability.yml` liga o log driver do Loki em todo container de todos os três arquivos compose. Sem o plugin instalado no host, qualquer `docker compose ... up` falha:

```bash
docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
```
```

Na tabela de endereços e credenciais, adicionar:

```markdown
| Grafana | http://localhost:3000 | `admin` / `admin` |
| Prometheus | http://localhost:9090 | — |
| Tempo | http://localhost:3200 | — |
| Loki | http://localhost:3100 | — (consultado via Grafana, não direto) |
| OTel Collector | `localhost:4317` (gRPC) / `localhost:4318` (HTTP) do host, `otel-collector:4317`/`:4318` de outros containers | aponte o exporter OpenTelemetry das apps para cá |
```

Remover, se ainda presentes, as linhas antigas de "Observabilidade (Grafana)" e "Observabilidade (OTLP)" que apontavam pro bundle `grafana/otel-lgtm` — foram substituídas pelas linhas acima.

- [ ] **Passo 3: Verificação ponta a ponta — subir tudo junto do zero**

```bash
pnpm infra:all:down 2>/dev/null || true
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml down -v
pnpm infra:all:up
sleep 30
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml -f infrastructure/local/docker-compose.observability.yml ps
```
Esperado: todos os serviços (core + tools + observability, ~18 containers) aparecem `running`/`healthy`.

- [ ] **Passo 4: Verificar que todos os alvos do Prometheus estão `up`**

```bash
curl -s http://localhost:9090/api/v1/targets | grep -o '"health":"[a-z]*"' | sort | uniq -c
```
Esperado: só `"health":"up"` na saída — zero `"health":"down"`. Se algum alvo estiver `down`, checar `docker compose logs <serviço>` do exporter correspondente antes de considerar a task concluída.

- [ ] **Passo 5: Verificar que os dashboards carregam dados reais**

Abrir `http://localhost:3000` (login `admin`/`admin`), entrar na pasta "Infra", e confirmar visualmente que pelo menos os dashboards "PostgreSQL Database" e "Node Exporter Full" mostram gráficos com dados (não "No data") — prova final de que scrape configs, datasources e resolução de variável de template (Task 10) estão todos corretos juntos.

- [ ] **Passo 6: Commit**

```bash
git add package.json infrastructure/local/README.md
git commit -m "feat(observability): add infra:observability/:all scripts, document setup in README"
```
