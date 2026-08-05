export const DATABASE_SCHEMA = 'ses_webhook_ingestor'

/*
 * Replaces (not appends) any existing `schema` param — URLSearchParams.set() overwrites, so this
 * can't silently produce a duplicate `schema=x&schema=y` pair where only the first value takes
 * effect (new URL(...).searchParams.get('schema') always returns the first match).
 */
export function withSchema(connectionString: string): string {
  const url = new URL(connectionString)
  url.searchParams.set('schema', DATABASE_SCHEMA)
  return url.href
}
