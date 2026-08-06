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
  url.searchParams.set('options', '-c lock_timeout=5s')
  /*
   * URLSearchParams serializes spaces as "+" (application/x-www-form-urlencoded), but Postgres's
   * own URI parser follows RFC 3986 and never decodes "+" back to a space — verified against a
   * real instance: psql read "-c+lock_timeout=5s" as the literal GUC name "+lock_timeout" and
   * rejected the connection. Any "+" already in the serialized string is safe to rewrite as %20:
   * `.href` would have escaped a literal "+" in an input value to "%2B", so every "+" left over
   * here can only be a space `.href` introduced.
   */
  datasource = { url: url.href.replaceAll('+', '%20') }
}

export default defineConfig({
  datasource,
  migrations: {
    path: './prisma/migrations'
  },
  schema: './prisma/schema'
})
