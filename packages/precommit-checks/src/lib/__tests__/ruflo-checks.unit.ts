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
  it('does not call exec when stagedFiles is empty', () => {
    const exec = vi.fn()
    const result = runSecretsScan(exec, [])
    expect(result.blocking).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('does not block when all staged files have no secrets', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: 'Scanned 1 file\n\nNo secrets detected.\n', stderr: '' })
    const result = runSecretsScan(exec, ['src/a.ts', 'src/b.ts'])
    expect(result.blocking).toBe(false)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('blocks when any staged file has secrets', () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'Scanned 1 file\n\nNo secrets detected.\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Scanned 1 file\n\n1 potential secret found: password',
        stderr: ''
      })
    const result = runSecretsScan(exec, ['src/a.ts', 'src/b.ts'])
    expect(result.blocking).toBe(true)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('does not block when the tool is unavailable', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'tool not found' })
    const result = runSecretsScan(exec, ['src/a.ts'])
    expect(result.blocking).toBe(false)
    // Tool error messages are still generated, so exec is called
    expect(exec).toHaveBeenCalled()
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
