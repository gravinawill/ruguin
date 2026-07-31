export function extractJson(stdout: string): unknown | null {
  const objectStart = stdout.indexOf('{')
  const arrayStart = stdout.indexOf('[')

  const candidates = [objectStart, arrayStart].filter((index) => index !== -1)
  if (candidates.length === 0) return null

  // Sort candidates by position and try each one until parsing succeeds
  candidates.sort((a, b) => a - b)

  for (const start of candidates) {
    try {
      return JSON.parse(stdout.slice(start))
    } catch {
      // Continue to next candidate
    }
  }

  return null
}
