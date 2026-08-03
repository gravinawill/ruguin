import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const distributionDirectory = path.join(process.cwd(), 'dist')

const RELATIVE_SPECIFIER_RE = /(\bfrom\s+|\bimport\(\s*)(['"])(\.\.?\/[^'"]*)\2/g
const KNOWN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.node'])
/*
 * `rewriteRelativeImportExtensions` (tsconfig) lets source import `./foo.ts` directly, but SWC
 * emits that specifier byte-for-byte instead of rewriting it — Node then fails to resolve a
 * literal `.ts` path at runtime. Map each source extension to its emitted counterpart so it gets
 * replaced, not appended to (a plain "no known extension" append would yield `./foo.ts.js`).
 */
const EMITTED_EXTENSION = new Map([
  ['.ts', '.js'],
  ['.mts', '.mjs'],
  ['.cts', '.cjs']
])

/*
 * NestJS files are dot-named (`health.module`, `health.controller`), so a naive
 * "ends in a dot + word chars" check misreads the name as already having an
 * extension. Only strings from KNOWN_EXTENSIONS/EMITTED_EXTENSION count.
 */
function splitExtension(specifier) {
  const lastDot = specifier.lastIndexOf('.')
  const lastSlash = specifier.lastIndexOf('/')
  if (lastDot <= lastSlash) return { base: specifier, extension: null }
  return { base: specifier.slice(0, lastDot), extension: specifier.slice(lastDot) }
}

function fixSpecifier(specifier) {
  const { base, extension } = splitExtension(specifier)
  if (extension === null) return `${specifier}.js`
  if (EMITTED_EXTENSION.has(extension)) return `${base}${EMITTED_EXTENSION.get(extension)}`
  return KNOWN_EXTENSIONS.has(extension) ? specifier : `${specifier}.js`
}

function fixFile(filePath) {
  const source = readFileSync(filePath, 'utf8')
  const fixed = source.replaceAll(
    RELATIVE_SPECIFIER_RE,
    (match, prefix, quote, specifier) => `${prefix}${quote}${fixSpecifier(specifier)}${quote}`
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
