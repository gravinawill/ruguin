# Guia de Migrations de Banco em Produção

**Escopo:** regras para escrever migrations Prisma que não derrubam nem travam produção, e o
runbook de rollback quando uma migration causa problema. Aplica a qualquer app do monorepo que use
Prisma contra Postgres (`core-server` hoje; `ses-webhook-ingestor` e futuros apps quando ganharem
overlay de produção). Mecanismo de execução (quando/onde `prisma migrate deploy` roda) é o Job
PreSync do ArgoCD — ver
`docs/superpowers/specs/2026-08-06-production-migration-strategy-design.md`.

## 1. Toda mudança estrutural é expand/contract

Nenhuma migration muda o schema de um jeito que quebra o código da release anterior — durante um
rollout, código velho e novo servem tráfego ao mesmo tempo. Renomear coluna, mudar tipo, remover
coluna em uso: nunca em um passo só, sempre como sequência de deploys:

1. **Expand** — adiciona o novo shape, código passa a escrever nos dois lugares.
2. **Migrate** — backfill dos dados existentes para o novo shape.
3. **Contract** — só depois que o rollout anterior estabilizou e nada mais lê o shape antigo,
   remove-o.

## 2. Índice ou constraint única: sempre `CONCURRENTLY`, um statement por arquivo

`CREATE INDEX`/`DROP INDEX` sem `CONCURRENTLY` trava escrita na tabela inteira até terminar de
construir. Regra: sempre `CONCURRENTLY`. E porque o Postgres recusa `CONCURRENTLY` dentro de uma
transação — e o Prisma envolve cada `migration.sql` numa — cada statement `CONCURRENTLY` vive
sozinho no seu próprio arquivo:

```sql
-- migration A: só isso, nada mais no arquivo
DROP INDEX CONCURRENTLY IF EXISTS "emails_projectId_idx";
```

```sql
-- migration B, arquivo separado
CREATE INDEX CONCURRENTLY "emails_projectId_idx" ON "emails"("projectId");
```

## 3. Foreign key ou CHECK numa tabela existente: `NOT VALID` + `VALIDATE CONSTRAINT`

`ADD CONSTRAINT` direto escaneia e trava a tabela inteira pra validar linhas existentes. Em duas
migrations: `... ADD CONSTRAINT ... NOT VALID` (lock rápido, não escaneia, vale só a partir dali) e
depois `... VALIDATE CONSTRAINT ...` (lock mais leve, não bloqueia escrita concorrente).

## 4. Coluna nova: sem reescrever a tabela

`DEFAULT` constante ou nullable não reescreve a tabela (Postgres 11+). Pra exigir `NOT NULL`: coluna
nullable → backfill em lote (regra 5) → só então `ALTER COLUMN ... SET NOT NULL`.

## 5. Backfill grande: em lote, nunca um `UPDATE` cobrindo a tabela inteira

Nenhuma migration roda `UPDATE`/`DELETE` sem filtro sobre uma tabela inteira. Lote de tamanho fixo
(ex.: `WHERE id BETWEEN ... AND ...`, repetido), pra não segurar uma transação longa nem inchar o
WAL.

## 6. `lock_timeout` curto na sessão de migration

Sem isso, uma migration que esbarra numa query longa já em andamento fica na fila de lock — e tudo
que vier depois dela na mesma tabela enfileira atrás, inclusive tráfego normal da app. É o cenário
clássico de "uma migration derrubou a produção inteira". `lock_timeout` curto faz a migration falhar
rápido em vez disso — falha visível no Job de deploy é preferível a lock silencioso em cascata.

## 7. Checklist de revisão de PR

Quando o diff toca `prisma/migrations/`, confira:

- [ ] Mudança estrutural (rename/type change/drop coluna em uso) está fatiada em
      expand → migrate → contract, não num passo só? (regra 1)
- [ ] Todo `CREATE INDEX`/`DROP INDEX` usa `CONCURRENTLY`, cada um em arquivo próprio? (regra 2)
- [ ] Toda `FOREIGN KEY`/`CHECK` nova numa tabela com dados usa `NOT VALID` + `VALIDATE CONSTRAINT`
      separados? (regra 3)
- [ ] Coluna `NOT NULL` nova passou por nullable → backfill → `SET NOT NULL`? (regra 4)
- [ ] Nenhum `UPDATE`/`DELETE` sem filtro de lote sobre uma tabela inteira? (regra 5)

## 8. Rollback: forward-only

Prisma Migrate não tem down-migration nativa — cada migration é só um `up`. Nenhuma migration
aplicada em produção é revertida. Um problema vira uma **nova migration corretiva**, nunca uma
tentativa de desfazer a anterior.

**Runbook — migration causou problema em produção:**

1. Se o Job de migration falhou: nada a reverter, o `Deployment` novo nunca subiu, código velho
   nunca deixou de servir. Corrija a migration e deploye de novo.
2. Se a migration **aplicou com sucesso** mas o efeito é indesejado (índice errado, coluna com
   default errado): escreva uma migration corretiva normal (`prisma migrate dev` local pra gerar o
   arquivo) e deploye como qualquer outra mudança.
3. `prisma migrate resolve --rolled-back` só depois que o dado já foi corrigido manualmente fora do
   fluxo normal (incidente grave com intervenção direta no banco) — destrava o histórico do Prisma
   nesse cenário, nunca é a primeira resposta.
