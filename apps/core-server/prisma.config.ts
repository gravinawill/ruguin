import { defineConfig } from 'prisma/config'

/*
 * lock_timeout guards against a migration queuing behind a long-running query and cascading into
 * a full outage (see docs/database-migrations-guide.md §6) — the cheapest protection available,
 * so it belongs on every CLI connection, not just ones an operator remembers to set by hand. Built
 * via the URL API, not string concatenation, because DATABASE_URL already carries `?schema=...` in
 * every real environment (infrastructure/terraform/external-secrets.tf) — a second query param has
 * to be appended correctly, the same approach resolveSchemaFrom uses to read `schema` back out
 * (src/shared/infrastructure/database/prisma/prisma.service.ts).
 */
const databaseUrl = process.env.DATABASE_URL
let datasource = {}
if (databaseUrl !== undefined && databaseUrl !== '') {
  const url = new URL(databaseUrl)
  /*
   * Built by hand instead of via `url.searchParams.set(...)` + a global "+"→"%20" replace: that
   * approach (previously used here) rewrote every "+" in the ENTIRE serialized URL, not just the
   * one it introduced — corrupting a literal "+" in the userinfo (e.g. a password) or path, which
   * use percent-encode sets that don't escape "+" the way `URLSearchParams` does. `encodeURIComponent`
   * percent-encodes the space directly (%20, never "+"), so the options value is safe to append as
   * a plain string without touching anything the URL constructor already produced.
   */
  const optionsParameter = `options=${encodeURIComponent('-c lock_timeout=5s')}`
  const separator = url.search === '' ? '?' : '&'
  datasource = { url: `${url.href}${separator}${optionsParameter}` }
}

export default defineConfig({
  datasource,
  migrations: {
    path: './prisma/migrations'
  },
  schema: './prisma/schema'
})
