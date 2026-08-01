import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type Baseline = {
  updatedAt: string
  complexity: Record<string, { cyclomatic: number; cognitive: number }>
  dependencies: Record<string, { connections: number }>
}

const EMPTY_BASELINE: Baseline = { updatedAt: '', complexity: {}, dependencies: {} }

export function readBaseline(path: string): Baseline {
  if (!existsSync(path)) return EMPTY_BASELINE

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Baseline
  } catch {
    return EMPTY_BASELINE
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
