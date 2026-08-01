import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type Baseline = {
  updatedAt: string
  complexity: Record<string, { cyclomatic: number; cognitive: number }>
  dependencies: Record<string, { connections: number }>
}

/*
 * A fresh object (including fresh nested `complexity`/`dependencies` objects — a shallow
 * `{ ...emptyBaseline() }` alone would still share those two by reference) is constructed on
 * every call below, never a shared module-level constant returned by reference, so a future
 * mutating caller can't corrupt what every other missing/corrupt-baseline call also gets.
 */
function emptyBaseline(): Baseline {
  return { updatedAt: '', complexity: {}, dependencies: {} }
}

export function readBaseline(path: string): Baseline {
  if (!existsSync(path)) return emptyBaseline()

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Baseline
  } catch {
    return emptyBaseline()
  }
}

export function writeBaseline(path: string, baseline: Baseline): void {
  writeFileSync(path, JSON.stringify(baseline, null, 2))
}

export function complexityRegressed(
  baseline: Baseline,
  file: string,
  current: { cyclomatic: number; cognitive: number }
): boolean {
  const previous = baseline.complexity[file]
  if (!previous) return false

  return current.cyclomatic > previous.cyclomatic || current.cognitive > previous.cognitive
}

export function dependenciesRegressed(baseline: Baseline, file: string, current: { connections: number }): boolean {
  const previous = baseline.dependencies[file]
  if (!previous) return false

  return current.connections > previous.connections
}
