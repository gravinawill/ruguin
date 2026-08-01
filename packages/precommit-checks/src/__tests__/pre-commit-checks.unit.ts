import { describe, expect, it, vi } from 'vitest'

import { runAllChecks } from '../pre-commit-checks'

function execReturning(mapping: Record<string, { status: number; stdout: string; stderr?: string }>) {
  return vi.fn((_command: string, arguments_: string[]) => {
    const key = arguments_.join(' ')
    const match = Object.entries(mapping).find(([pattern]) => key.includes(pattern))
    if (!match) return { status: 0, stdout: '', stderr: '' }
    return { status: match[1].status, stdout: match[1].stdout, stderr: match[1].stderr ?? '' }
  })
}

const CLEAN_MAPPING = {
  'check --cycles': { status: 0, stdout: '{"status":"clean","cycleCount":0,"cycles":[]}' },
  'detect-changes': { status: 0, stdout: 'Changes: 0 files, 0 symbols\nRisk level: low\n\nChanged symbols:\n' },
  'diff --risk': { status: 0, stdout: '{"risk":{"overall":"low"}}' },
  'security secrets': { status: 0, stdout: 'No secrets detected.' },
  'analyze complexity': { status: 0, stdout: '{"files":[],"summary":{}}' },
  'analyze dependencies': { status: 0, stdout: '{"nodes":[],"edges":[]}' },
  'analyze symbols': { status: 0, stdout: '{"symbols":[]}' },
  'analyze imports': { status: 0, stdout: '{"imports":[]}' },
  'analyze boundaries': { status: 0, stdout: 'ok' },
  'analyze modules': { status: 0, stdout: 'ok' },
  'analyze ast': { status: 0, stdout: '{}' },
  'analyze deps': { status: 0, stdout: '{}' }
}

const EMPTY_BASELINE = { updatedAt: '', complexity: {}, dependencies: {} }

describe('runAllChecks', () => {
  it('passes when every check is clean', () => {
    const result = runAllChecks(execReturning(CLEAN_MAPPING), '/repo', ['src/a.ts'], EMPTY_BASELINE)
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('fails when the cycle check finds something', () => {
    const exec = execReturning({
      ...CLEAN_MAPPING,
      'check --cycles': { status: 0, stdout: '{"status":"cycles-found","cycleCount":1,"cycles":["a -> b -> a"]}' }
    })
    const result = runAllChecks(exec, '/repo', ['src/a.ts'], EMPTY_BASELINE)
    expect(result.pass).toBe(false)
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('fails when the secrets scan finds something', () => {
    const exec = execReturning({ ...CLEAN_MAPPING, 'security secrets': { status: 0, stdout: '1 secret found' } })
    const result = runAllChecks(exec, '/repo', ['src/a.ts'], EMPTY_BASELINE)
    expect(result.pass).toBe(false)
  })

  it('collects report-only output without affecting pass/fail', () => {
    const result = runAllChecks(execReturning(CLEAN_MAPPING), '/repo', ['src/a.ts'], EMPTY_BASELINE)
    expect(result.pass).toBe(true)
    expect(Object.keys(result.report)).toEqual(
      expect.arrayContaining(['symbols', 'imports', 'boundaries', 'modules', 'ast', 'deps'])
    )
  })

  it('returns current complexity/dependencies metrics for staged files when it passes', () => {
    const exec = execReturning({
      ...CLEAN_MAPPING,
      'analyze complexity': {
        status: 0,
        stdout: '{"files":[{"file":"/repo/src/a.ts","cyclomatic":3,"cognitive":2}],"summary":{}}'
      },
      'analyze dependencies': {
        status: 0,
        stdout: '{"nodes":[],"edges":[{"source":"src/a.ts","target":"src/b.ts"}]}'
      }
    })
    const result = runAllChecks(exec, '/repo', ['src/a.ts'], EMPTY_BASELINE)
    expect(result.pass).toBe(true)
    expect(result.currentMetrics.complexity).toEqual({ 'src/a.ts': { cyclomatic: 3, cognitive: 2 } })
    expect(result.currentMetrics.dependencies).toEqual({ 'src/a.ts': { connections: 1 } })
  })
})
