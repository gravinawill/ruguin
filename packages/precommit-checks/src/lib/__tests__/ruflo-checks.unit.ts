import type { Baseline } from '../baseline'

import { describe, expect, it, vi } from 'vitest'

import {
  runComplexityRegression,
  runDependenciesRegression,
  runDiffRisk,
  runReportOnly,
  runSecretsScan
} from '../ruflo-checks'

describe('runDiffRisk', () => {
  it('blocks when risk.overall is not low', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout: '[INFO] noise\n{"risk":{"overall":"high","score":80}}',
      stderr: ''
    })
    expect(runDiffRisk(exec).blocking).toBe(true)
  })

  it('does not block on low risk', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '{"risk":{"overall":"low","score":3}}', stderr: '' })
    expect(runDiffRisk(exec).blocking).toBe(false)
  })
})

describe('runSecretsScan', () => {
  it('does not block when "No secrets detected." is present', () => {
    const exec = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: 'Scanned 10 files\n\nNo secrets detected.\n', stderr: '' })
    expect(runSecretsScan(exec).blocking).toBe(false)
  })

  it('blocks when the pass message is absent', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'Scanned 10 files\n\n1 potential secret found in src/config.ts',
      stderr: ''
    })
    expect(runSecretsScan(exec).blocking).toBe(true)
  })
})

describe('runComplexityRegression', () => {
  const baseline: Baseline = {
    updatedAt: '',
    complexity: { 'src/a.ts': { cyclomatic: 5, cognitive: 5 } },
    dependencies: {}
  }

  it('blocks when a staged file regressed', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout:
        '{"files":[{"file":"/repo/src/a.ts","cyclomatic":9,"cognitive":9,"rating":"Complex","flagged":true}],"summary":{}}',
      stderr: ''
    })
    const result = runComplexityRegression(exec, '/repo', ['src/a.ts'], baseline)
    expect(result.blocking).toBe(true)
  })

  it('does not block when no staged file regressed', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout:
        '{"files":[{"file":"/repo/src/a.ts","cyclomatic":5,"cognitive":5,"rating":"Simple","flagged":false}],"summary":{}}',
      stderr: ''
    })
    const result = runComplexityRegression(exec, '/repo', ['src/a.ts'], baseline)
    expect(result.blocking).toBe(false)
  })
})

describe('runDependenciesRegression', () => {
  const baseline: Baseline = { updatedAt: '', complexity: {}, dependencies: { 'src/a.ts': { connections: 1 } } }

  it('blocks when a staged file has more connections than baseline', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout:
        '{"nodes":[{"path":"src/a.ts"},{"path":"src/b.ts"}],"edges":[{"source":"src/a.ts","target":"src/b.ts"},{"source":"src/c.ts","target":"src/a.ts"}]}',
      stderr: ''
    })
    const result = runDependenciesRegression(exec, ['src/a.ts'], baseline)
    expect(result.blocking).toBe(true)
  })
})

describe('runReportOnly', () => {
  it('parses JSON output when possible', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '[INFO] noise\n{"symbols":[]}', stderr: '' })
    expect(runReportOnly(exec, 'symbols')).toEqual({ subcommand: 'symbols', output: { symbols: [] } })
  })

  it('falls back to raw text when the output is not JSON', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: 'plain text report', stderr: '' })
    expect(runReportOnly(exec, 'boundaries')).toEqual({ subcommand: 'boundaries', output: 'plain text report' })
  })
})
