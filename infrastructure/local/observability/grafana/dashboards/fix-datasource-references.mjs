import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Dashboards exported from grafana.com reference the datasource via a template
 * variable (${DS_PROMETHEUS}, ${DS_LOKI}, or a custom name the original author
 * picked, e.g. ${DS_CORTEX}), only resolved automatically by the manual UI import
 * flow. In file-based provisioning (Task 9/10) that variable is left unresolved and
 * the dashboard loads with no data -- so we swap it for the literal datasource name,
 * the same one defined in provisioning/datasources/datasources.yaml. The custom-name
 * case is handled by reading each dashboard's own `__inputs` array, since exporters
 * don't agree on a fixed variable name for a given datasource type.
 */
const PLUGIN_TO_DATASOURCE = {
  prometheus: 'Prometheus',
  loki: 'Loki'
}

const BASE_REPLACEMENTS = {
  '${DS_PROMETHEUS}': 'Prometheus',
  '${DS_LOKI}': 'Loki'
}

const directory = path.dirname(fileURLToPath(import.meta.url))
const files = readdirSync(directory)

for (const file of files) {
  if (!file.endsWith('.json')) continue

  const filePath = path.join(directory, file)
  let content = readFileSync(filePath, 'utf8')
  const dashboard = JSON.parse(content)

  const replacements = { ...BASE_REPLACEMENTS }
  const inputs = dashboard.__inputs ?? []
  for (const input of inputs) {
    const literal = PLUGIN_TO_DATASOURCE[input.pluginId]
    if (literal && input.type === 'datasource') {
      replacements[`\${${input.name}}`] = literal
    }
  }

  for (const [placeholder, replacement] of Object.entries(replacements)) {
    content = content.replaceAll(placeholder, () => replacement)
  }

  writeFileSync(filePath, content)
  console.log(`fixed datasource refs: ${file}`)
}
