# Task 10: Dashboards provisionados

**Depende de:** Task 9 (Grafana + provider de dashboards), Task 6 (`postgres_exporter`), Task 7 (kminion), Task 8 (`node_exporter`/cAdvisor)
**Próximas tasks que dependem desta:** nenhuma

## Contexto

Em vez de construir dashboards do zero, baixamos dashboards prontos da comunidade (`grafana.com`) direto pro disco, como arquivo versionado — chegam funcionais imediatamente e continuam customizáveis depois. O único ajuste necessário: dashboards exportados do `grafana.com` referenciam o datasource por uma variável de template, que só é resolvida automaticamente no fluxo de *import* manual pela UI — no provisionamento por arquivo (o que usamos aqui, Task 9) essa variável não é resolvida sozinha, então um script pós-processa o JSON baixado trocando a variável pelo nome literal do datasource (`Prometheus`, `Loki` — os mesmos nomes definidos em `datasources.yaml` na Task 9). Autores diferentes escolhem nomes de variável diferentes pro mesmo tipo de datasource (`${DS_PROMETHEUS}`, `${DS_CORTEX}`, `${DS_GRAFANACLOUD-SHIZUN-PROM}`, ...) — o script abaixo deriva o nome real por arquivo a partir do próprio array `__inputs` de cada dashboard, em vez de fixar um nome só, já que 3 dos 6 dashboards abaixo usam um nome não-padrão.

> **Limitação conhecida, não é bug:** `postgres-overview.json` (9628) e `docker-monitoring.json` (15798) foram construídos assumindo um deploy Kubernetes/Helm — as variáveis de template deles filtram por labels (`kubernetes_namespace`, `release`, `service`, `container`) que um deploy docker-compose puro nunca emite, então a maioria dos painéis desses dois dashboards vai mostrar "No data" mesmo com o datasource resolvido corretamente e mesmo as métricas subjacentes existindo de verdade no Prometheus (verificado direto). `node-exporter-full.json` (1860) é autoconsistente e renderiza dados reais em tudo; os três dashboards do kminion (14012/14013/14014) funcionam na maior parte. Isso é uma limitação do design de variáveis dos dashboards da comunidade escolhidos, não desta task — trocar por alternativas sem Kubernetes é trabalho futuro, se algum dia importar, não é exigido por este plano.

## Arquivos

- Criar: `infrastructure/local/observability/grafana/dashboards/fix-datasource-references.mjs`
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

Criar `infrastructure/local/observability/grafana/dashboards/fix-datasource-references.mjs` (nome com a palavra completa "references" — o `unicorn/name-replacements` do ESLint deste repo rejeita a abreviação "refs" em identificadores/nomes de arquivo):

```javascript
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dashboards exportados do grafana.com referenciam o datasource via variável de
// template (${DS_PROMETHEUS}, ${DS_LOKI}, ou um nome customizado que o autor
// original escolheu, ex: ${DS_CORTEX}), resolvida automaticamente só no fluxo de
// import manual pela UI. No provisionamento por arquivo (Task 9/10) essa variável
// fica sem resolver, e o dashboard carrega sem dados -- por isso trocamos pelo nome
// literal do datasource, o mesmo definido em provisioning/datasources/datasources.yaml.
// O caso de nome customizado é tratado lendo o array `__inputs` de cada dashboard,
// já que os exporters não concordam num nome fixo de variável pro mesmo tipo de datasource.
const PLUGIN_TO_DATASOURCE = {
  prometheus: 'Prometheus',
  loki: 'Loki',
};

const BASE_REPLACEMENTS = {
  '${DS_PROMETHEUS}': 'Prometheus',
  '${DS_LOKI}': 'Loki',
};

const directory = path.dirname(fileURLToPath(import.meta.url));

for (const file of readdirSync(directory)) {
  if (!file.endsWith('.json')) continue;

  const filePath = path.join(directory, file);
  let content = readFileSync(filePath, 'utf8');
  const dashboard = JSON.parse(content);

  const replacements = { ...BASE_REPLACEMENTS };
  const inputs = dashboard.__inputs ?? [];
  for (const input of inputs) {
    const literal = PLUGIN_TO_DATASOURCE[input.pluginId];
    if (literal && input.type === 'datasource') {
      replacements[`\${${input.name}}`] = literal;
    }
  }

  for (const [placeholder, replacement] of Object.entries(replacements)) {
    content = content.replaceAll(placeholder, () => replacement);
  }

  writeFileSync(filePath, content);
  console.log(`fixed datasource refs: ${file}`);
}
```

- [ ] **Passo 3: Rodar o script**

```bash
node infrastructure/local/observability/grafana/dashboards/fix-datasource-references.mjs
```
Esperado: imprime uma linha `fixed datasource refs: <arquivo>.json` para cada um dos 6 dashboards baixados no Passo 1.

- [ ] **Passo 4: Recarregar o Grafana e verificar**

O provider de dashboards (Task 9) já está com `updateIntervalSeconds: 30`, então recarrega sozinho — mas pra verificar imediatamente:

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml restart grafana
sleep 10
curl -s -u admin:admin http://localhost:3000/api/search?folderIds=0 | grep -o '"title":"[^"]*"'
```
Esperado: lista os 6 dashboards pela `title` de cada um. Abrir `http://localhost:3000` no navegador, entrar na pasta "Infra", abrir o dashboard "Node Exporter Full" e confirmar que os painéis mostram dados reais (não "No data") — prova de que a Task 8 (`node_exporter`) está realmente alimentando o Prometheus e que a resolução do datasource (Passo 2/3) funcionou. Pela nota de limitação conhecida acima, não espere o mesmo de "PostgreSQL Database" ou "Docker monitoring" — verifique esses dois consultando o Prometheus direto (ex: `curl -s http://localhost:9090/api/v1/query --data-urlencode 'query=pg_up'` deve retornar dado real mesmo que o painel do dashboard não mostre, por causa das variáveis de template orientadas a Kubernetes desses dois dashboards específicos).

- [ ] **Passo 5: Commit**

```bash
git add infrastructure/local/observability/grafana/dashboards/
git commit -m "feat(observability): provision community dashboards (node, postgres, docker, kafka)"
```
