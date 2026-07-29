# Task 10: Dashboards provisionados

**Depende de:** Task 9 (Grafana + provider de dashboards), Task 6 (`postgres_exporter`), Task 7 (kminion), Task 8 (`node_exporter`/cAdvisor)
**Próximas tasks que dependem desta:** nenhuma

## Contexto

Em vez de construir dashboards do zero, baixamos dashboards prontos da comunidade (`grafana.com`) direto pro disco, como arquivo versionado — chegam funcionais imediatamente e continuam customizáveis depois. O único ajuste necessário: dashboards exportados do `grafana.com` referenciam o datasource por uma variável de template (`${DS_PROMETHEUS}`), que só é resolvida automaticamente no fluxo de *import* manual pela UI — no provisionamento por arquivo (o que usamos aqui, Task 9) essa variável não é resolvida sozinha, então um script pós-processa o JSON baixado trocando a variável pelo nome literal do datasource (`Prometheus`, `Loki` — os mesmos nomes definidos em `datasources.yaml` na Task 9).

## Arquivos

- Criar: `infrastructure/local/observability/grafana/dashboards/fix-datasource-refs.mjs`
- Criar: `infrastructure/local/observability/grafana/dashboards/*.json` (baixados, não escritos à mão)

## Interfaces

- **Consome:** provider de dashboards da Task 9 (lê `/var/lib/grafana/dashboards`, montado a partir desta pasta); datasource `Prometheus` (Task 9); dados reais expostos por `postgres_exporter` (Task 6), kminion (Task 7), `node_exporter`/cAdvisor (Task 8).

## Passos

- [ ] **Passo 1: Baixar os dashboards da comunidade**

```bash
mkdir -p infrastructure/local/observability/grafana/dashboards
curl -sL 'https://grafana.com/api/dashboards/1860/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/node-exporter-full.json
curl -sL 'https://grafana.com/api/dashboards/9628/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/postgres-overview.json
curl -sL 'https://grafana.com/api/dashboards/15798/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/docker-monitoring.json
curl -sL 'https://grafana.com/api/dashboards/14012/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/kminion-cluster.json
curl -sL 'https://grafana.com/api/dashboards/14013/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/kminion-topic.json
curl -sL 'https://grafana.com/api/dashboards/14014/revisions/latest/download' -o infrastructure/local/observability/grafana/dashboards/kminion-groups.json
```

- [ ] **Passo 2: Criar o script que resolve as referências de datasource**

Criar `infrastructure/local/observability/grafana/dashboards/fix-datasource-refs.mjs`:

```javascript
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dashboards exportados do grafana.com referenciam o datasource via variável de
// template (${DS_PROMETHEUS}, ${DS_LOKI}), resolvida automaticamente só no fluxo de
// import manual pela UI. No provisionamento por arquivo (Task 9/10) essa variável fica
// sem resolver, e o dashboard carrega sem dados -- por isso trocamos pelo nome literal
// do datasource, o mesmo definido em provisioning/datasources/datasources.yaml.
const REPLACEMENTS = {
  '${DS_PROMETHEUS}': 'Prometheus',
  '${DS_LOKI}': 'Loki',
};

const dir = dirname(fileURLToPath(import.meta.url));

for (const file of readdirSync(dir)) {
  if (!file.endsWith('.json')) continue;

  const path = join(dir, file);
  let content = readFileSync(path, 'utf8');

  for (const [placeholder, replacement] of Object.entries(REPLACEMENTS)) {
    content = content.replaceAll(placeholder, replacement);
  }

  writeFileSync(path, content);
  console.log(`fixed datasource refs: ${file}`);
}
```

- [ ] **Passo 3: Rodar o script**

```bash
node infrastructure/local/observability/grafana/dashboards/fix-datasource-refs.mjs
```
Esperado: imprime uma linha `fixed datasource refs: <arquivo>.json` para cada um dos 6 dashboards baixados no Passo 1.

- [ ] **Passo 4: Recarregar o Grafana e verificar**

O provider de dashboards (Task 9) já está com `updateIntervalSeconds: 30`, então recarrega sozinho — mas pra verificar imediatamente:

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml restart grafana
sleep 10
curl -s -u admin:admin http://localhost:3000/api/search?folderIds=0 | grep -o '"title":"[^"]*"'
```
Esperado: lista os 6 dashboards pela `title` de cada um. Abrir `http://localhost:3000` no navegador, entrar na pasta "Infra", abrir o dashboard "PostgreSQL Database" e confirmar que os painéis mostram dados reais (não "No data") — prova de que a Task 6 (`postgres_exporter`) está realmente alimentando o Prometheus e que a resolução do datasource (Passo 2/3) funcionou.

- [ ] **Passo 5: Commit**

```bash
git add infrastructure/local/observability/grafana/dashboards/
git commit -m "feat(observability): provision community dashboards (node, postgres, docker, kafka)"
```
