import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const distributionDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const RELATIVE_SPECIFIER_RE = /(\bfrom\s+|\bimport\(\s*)(['"])(\.\.?\/[^'"]*)\2/g
const KNOWN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.node'])

/*
 * NestJS files are dot-named (`health.module`, `health.controller`), so a naive
 * "ends in a dot + word chars" check misreads the name as already having an
 * extension. Only strings from KNOWN_EXTENSIONS count.
 */
function hasExtension(specifier) {
  const lastDot = specifier.lastIndexOf('.')
  const lastSlash = specifier.lastIndexOf('/')
  if (lastDot <= lastSlash) return false
  return KNOWN_EXTENSIONS.has(specifier.slice(lastDot))
}

function fixFile(filePath) {
  const source = readFileSync(filePath, 'utf8')
  const fixed = source.replaceAll(RELATIVE_SPECIFIER_RE, (match, prefix, quote, specifier) =>
    hasExtension(specifier) ? match : `${prefix}${quote}${specifier}.js${quote}`
  )

  if (fixed !== source) writeFileSync(filePath, fixed)
}

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry)
    if (statSync(fullPath).isDirectory()) {
      walk(fullPath)
    } else if (entry.endsWith('.js')) {
      fixFile(fullPath)
    }
  }
}

walk(distributionDirectory)
