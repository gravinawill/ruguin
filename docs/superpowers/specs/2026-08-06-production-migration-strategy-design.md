# Estratégia de migrations de banco em produção sem downtime

## Contexto

Hoje nada dispara `prisma migrate deploy` automaticamente contra nenhum ambiente — não há step no
CI, nem Job ou hook no Kubernetes. O deploy do core-server é 100% GitOps: `release-image.yml`
builda, escaneia e assina a imagem e só promove o digest para o `kustomization.yaml` do overlay
correspondente (`infrastructure/k8s/core-server/overlays/{production,development}/`); o ArgoCD
sincroniza o `Deployment` a partir daí sozinho. `production` ainda está com o digest placeholder —
nunca houve um deploy real — mas `deletion_protection`, backup de 7 dias e o resto da infra do RDS
(`aws_db_instance.core_server`, `db.t4g.micro`, single-AZ) já estão de pé, então essa lacuna precisa
fechar antes do primeiro deploy real, não depois.

`production` e `development` compartilham o mesmo RDS, separados por schema Postgres
(`core_server` vs `core_server_dev`, ver `2026-08-05-multi-environment-deploy-design.md`) —
`prisma migrate deploy` contra cada `DATABASE_URL` é o que cria e popula o schema correspondente.

Já existe um precedente do problema central desta spec: uma worktree paralela (não mergeada) recria
um índice via `DROP/CREATE INDEX CONCURRENTLY`, cada `CONCURRENTLY` em seu próprio arquivo de
migration — porque o Postgres recusa `CONCURRENTLY` dentro de uma transação e o Prisma envolve cada
`migration.sql` numa. Essa spec formaliza esse padrão como regra, em vez de deixá-lo como
conhecimento tácito de quem escreveu aquela migration.

Escopo: um padrão reutilizável para qualquer serviço que use Prisma contra Postgres neste monorepo
— core-server hoje, `ses-webhook-ingestor` (já usa Prisma, ainda sem infra de produção) ou qualquer
outro serviço futuro que ganhe overlay de produção.

## Objetivo

Nenhuma migration aplicada em produção deve: (a) derrubar ou travar o serviço enquanto está sendo
aplicada, ou (b) quebrar o código da versão anterior que ainda está servindo tráfego durante o
rollout. As duas garantias vêm de peças diferentes: (a) é regra de como escrever a migration
(Decisões 3-8); (b) é ordem de execução no pipeline de deploy (Decisão 1).

## Decisões

### 1. Mecanismo: ArgoCD PreSync Hook Job

Um novo `Job` do Kubernetes, `infrastructure/k8s/core-server/base/migration-job.yaml`, anotado como
hook do ArgoCD:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: core-server-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 300
  template:
    spec:
      restartPolicy: Never
      imagePullSecrets:
        - name: ghcr-pull-secret
      containers:
        - name: migrate
          image: ghcr.io/gravinawill/ruguin/core-server
          command: ['node_modules/.bin/prisma', 'migrate', 'deploy']
          envFrom:
            - secretRef:
                name: core-server-secrets
          resources:
            requests: { cpu: 100m, memory: 128Mi, ephemeral-storage: 128Mi }
            limits: { cpu: 100m, memory: 128Mi, ephemeral-storage: 128Mi }
```

ArgoCD roda hooks `PreSync` **antes** de sincronizar os demais recursos do `Application`. Se o Job
falhar, o sync inteiro é marcado como falho e o `Deployment` novo nunca é aplicado — os pods antigos
continuam servindo com o schema anterior, que por construção (Decisões 3-8) ainda é compatível com
eles. Resultado: uma migration ruim atrasa o deploy, não derruba produção.

Por viver em `base/`, os dois overlays herdam o mesmo Job automaticamente — `development` roda a
mesma migration contra `core_server_dev` antes de `production` sequer existir como overlay real,
virando um staging de graça: toda migration passa pelo fluxo normal `develop → master` do git flow
antes de chegar em produção.

Reaproveita o que já existe, sem plumbing novo:

- **Imagem**: a mesma que o `Deployment` já usa — só troca o `command` padrão (que sobe a app) por
  `prisma migrate deploy`. `pnpm --filter @ruguin/core-server deploy --prod --legacy /prod` no
  Dockerfile já preserva a pasta `prisma/` (schema + `migrations/`) na imagem final; confirmar isso
  no plano de implementação antes de assumir que o Job consegue rodar sem mudança no Dockerfile.
- **Credenciais**: o mesmo `Secret` `core-server-secrets` (populado por ExternalSecret a partir do
  Secrets Manager) que o `Deployment` já consome via `envFrom.secretRef` — já contém `DATABASE_URL`
  com o schema certo por ambiente.

Trade-off aceito: pods do Job levam ~30-60s pra agendar no Fargate, então cada deploy fica esse
tanto mais lento. Não há downtime nisso — é atraso no rollout, não indisponibilidade.

**Alternativas descartadas:**

- **Step de CI** rodando `migrate deploy` direto do GitHub Actions antes de promover o digest: o RDS
  está em subnet privada — exigiria runner dentro da VPC ou abrir rota temporária, além de
  credenciais de banco no CI. Quebra o modelo atual, onde só o ArgoCD fala com o cluster e o banco.
- **`initContainer`** no próprio `Deployment`: com `replicas: 2`, cada rollout dispara a migration em
  paralelo em cada pod. O lock consultivo interno do Prisma evita corrida, mas não há um gate único e
  observável — uma migration lenta trava o rollout de forma imprevisível, e falha de migration fica
  difícil de distinguir de pod crashando no monitoramento.

### 2. Retry e limpeza do Job

`backoffLimit: 1` — uma falha tenta de novo uma vez (cobre timeout transitório de conexão) e desiste
depois disso, deixando o pod do Job vivo (`hook-delete-policy: HookSucceeded` só apaga em sucesso)
para inspeção via `kubectl logs`. `activeDeadlineSeconds: 300` evita que uma migration presa segure
o deploy indefinidamente — 5 minutos é folga generosa para o volume de dados atual; revisitar se
migrations passarem a envolver backfill de tabelas grandes.

### 3. Expand/contract como regra, não como exceção

Nenhuma migration muda o schema de um jeito que quebra o código da release anterior. Mudança
estrutural (renomear coluna, mudar tipo, remover coluna em uso) vira uma sequência de deploys, nunca
um passo só:

1. **Expand** — adiciona o novo shape (coluna/tabela nova), código passa a escrever nos dois lugares.
2. **Migrate** — backfill dos dados existentes para o novo shape.
3. **Contract** — depois que o rollout anterior estabilizou e nada mais lê o shape antigo, remove-o.

Cada etapa precisa tolerar código velho *e* novo rodando ao mesmo tempo — é exatamente o que acontece
durante o intervalo do rollout do `Deployment`.

### 4. Índices e constraints únicas: sempre `CONCURRENTLY`, um por arquivo

`CREATE INDEX` e `DROP INDEX` tomam lock que bloqueia escrita na tabela inteira enquanto constroem;
a variante `CONCURRENTLY` evita isso. Regra: todo índice em produção usa `CONCURRENTLY`, e — porque o
Postgres recusa `CONCURRENTLY` dentro de transação e o Prisma envolve cada `migration.sql` numa —
cada statement `CONCURRENTLY` vive sozinho no seu próprio arquivo de migration (padrão já usado na
worktree `cozy-mixing-minsky`, formalizado aqui):

```sql
-- migration A: só isso, nada mais no arquivo
DROP INDEX CONCURRENTLY IF EXISTS "emails_projectId_idx";
```

```sql
-- migration B, arquivo separado
CREATE INDEX CONCURRENTLY "emails_projectId_idx" ON "emails"("projectId");
```

### 5. Foreign keys e CHECK em tabela existente: `NOT VALID` + `VALIDATE CONSTRAINT`

`ADD CONSTRAINT` direto escaneia e trava a tabela inteira para validar as linhas existentes.
`NOT VALID` cria a constraint sem esse escaneamento (lock rápido, aplica só a partir dali) e
`VALIDATE CONSTRAINT`, em migration separada, confere as linhas antigas com um lock mais leve que não
bloqueia escrita concorrente.

### 6. Coluna nova: sem reescrever a tabela

Coluna com `DEFAULT` constante ou nullable não reescreve a tabela (Postgres 11+). Para exigir
`NOT NULL`: adiciona nullable → backfill em lote → só então `ALTER COLUMN ... SET NOT NULL`.

### 7. Backfill grande: em lote, nunca um `UPDATE` cobrindo a tabela inteira

Nenhuma migration roda um `UPDATE` sem filtro sobre uma tabela inteira. Lote de tamanho fixo (ex.:
`WHERE id BETWEEN ... AND ...`, repetido), para não segurar uma transação longa nem inchar o WAL de
um `db.t4g.micro`. Tabelas hoje são pequenas — a regra existe para não reintroduzir o problema quando
crescerem.

### 8. `lock_timeout` curto na sessão de migration

Toda sessão que roda `migrate deploy` define um `lock_timeout` de poucos segundos. Sem isso, uma
migration que esbarra numa query longa já em andamento fica na fila de lock — e tudo que vier depois
dela na mesma tabela enfileira atrás, inclusive tráfego normal da aplicação. É o cenário clássico de
"uma migration derrubou a produção inteira" e a proteção mais barata contra ele. `lock_timeout` curto
faz a migration falhar rápido em vez disso — falha visível no Job (Decisão 1) é preferível a lock
silencioso em cascata.

### 9. Rollback: forward-only

Prisma Migrate não tem down-migration nativa — cada migration é só um `up`. Nenhuma migration
aplicada em produção é revertida. Um problema vira uma **nova migration corretiva**, nunca uma
tentativa de desfazer a anterior.

Runbook para quando uma migration causa problema em produção:

1. O Job de migration (Decisão 1) já bloqueou o rollout do `Deployment` se a migration falhou —
   nesse caso não há nada a reverter, o código velho nunca deixou de servir.
2. Se a migration **aplicou com sucesso** mas o efeito é indesejado (ex.: índice errado, coluna com
   default errado): escrever uma migration corretiva normal (novo arquivo, `prisma migrate dev` local
   para gerá-la) e deployar como qualquer outra mudança — passa pelo mesmo Job PreSync.
3. `prisma migrate resolve --rolled-back` só entra depois que o dado já foi corrigido manualmente
   fora do fluxo normal (ex.: incidente grave exigindo intervenção direta no banco) — serve para
   destravar o histórico do Prisma nesse cenário, nunca como primeira resposta.

### 10. Enforcement: checklist documentado, sem lint automatizado nesta v1

As Decisões 3-8 viram checklist de referência para revisão de PR quando o diff toca
`prisma/migrations/`. Sem gate automatizado no CI nesta primeira versão (YAGNI) — dá para adicionar
um check de padrões perigosos (`DROP COLUMN`, `RENAME`, `ALTER ... TYPE`, `CREATE INDEX` sem
`CONCURRENTLY`) plugado no `pre-commit-checks.mjs` que já existe, se migrations arriscadas passarem
batido na revisão humana com frequência.

### 11. Template reutilizável para outros serviços

Quando `ses-webhook-ingestor` (ou outro serviço Prisma) ganhar overlay de produção, o mesmo
`migration-job.yaml` (Decisão 1) é copiado para `infrastructure/k8s/<serviço>/base/`, trocando
apenas nome da imagem e do `Secret`. As Decisões 3-10 já valem sem alteração — são regras de SQL e
processo, não específicas do core-server.

## Testes

- **Ambiente `development` como staging real** (Decisão 1): toda migration já roda contra
  `core_server_dev` — mesmo RDS, schema isolado — antes de qualquer merge em `master` promover
  `production`. Cobre o caso mais comum: a migration falha ou trava ali, não em produção.
- **Verificação manual de lock** antes de mergear uma migration que toca tabela grande ou dado real:
  rodar a migration localmente contra uma cópia/subset e observar `pg_stat_activity` /
  `pg_locks` durante a aplicação, confirmando que não segura lock por mais que o `lock_timeout`
  configurado (Decisão 8).
- Nenhum teste automatizado novo de infraestrutura nesta spec — o Job em si (Decisão 1) é validado na
  prática no primeiro deploy real de `production`, que ainda não aconteceu.

## Fora de escopo

- Blue/green ou réplica de leitura para o RDS (`multi_az = false` hoje) — decisão de disponibilidade
  do banco em si, não de como as migrations rodam contra ele. Fica para uma spec própria se o SLA
  exigir.
- Lint automatizado de padrões perigosos em migration.sql — mencionado na Decisão 10 como extensão
  futura, não implementado agora.
- Migração do conteúdo de dados entre schemas/serviços (ex.: particionamento, sharding) — fora do
  problema "aplicar uma migration sem downtime".

## Riscos

- **Fargate cold start no Job** (Decisão 1) adiciona ~30-60s a todo deploy — aceito, é atraso, não
  indisponibilidade.
- **`db.t4g.micro` é uma instância pequena**: uma migration mal escrita que ignore a Decisão 7
  (backfill em lote) pode saturar CPU/IO da instância inteira, afetando todas as queries da app
  mesmo sem lock explícito. A regra mitiga, mas não existe um limite técnico automático além da
  revisão de PR (Decisão 10) enquanto o lint automatizado não existir.
- **`activeDeadlineSeconds: 300`** (Decisão 2) é uma estimativa para o volume de dados de hoje — uma
  migration legítima que precise de mais tempo (backfill grande futuro) vai precisar desse valor
  revisado, não só da regra de lote da Decisão 7.
