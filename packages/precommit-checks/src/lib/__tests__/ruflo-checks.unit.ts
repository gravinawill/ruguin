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

  it('warns (does not block) when the tool is unavailable', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'command not found' })
    const result = runDiffRisk(exec)
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(true)
  })
})

/*
 * Mirrors the real `ruflo security secrets --action scan -p <dir>` table output (confirmed
 * empirically — the tool has no `--format json` support). `rows` are `[type, location, risk]`
 * triples; `location` is `<path relative to the scanned dir>:<line>`.
 */
function secretsTableStdout(filesScanned: number, rows: Array<[string, string, string]> = []): string {
  const header = `Scanned ${filesScanned} files`
  if (rows.length === 0) {
    return `Secret Detection\n${header}\n\nNo secrets detected.\n`
  }

  const tableRows = rows.map(([type, location, risk]) => `| ${type} | ${location} | ${risk} | Rotate immediately |`)
  return [
    'Secret Detection',
    header,
    '',
    '| Secret Type | Location | Risk | Recommended |',
    ...tableRows,
    '',
    `| Files scanned: ${filesScanned} |`
  ].join('\n')
}

describe('runSecretsScan', () => {
  it('does not call exec when stagedFiles is empty', () => {
    const exec = vi.fn()
    const result = runSecretsScan(exec, '/repo', [])
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it("scans each staged file's containing directory (deduplicated) rather than the file itself, since the CLI's -p flag only accepts a directory", () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: secretsTableStdout(2), stderr: '' })
    const result = runSecretsScan(exec, '/repo', ['src/a.ts', 'src/b.ts'])
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(false)
    expect(result.message).toBe('No secrets detected.')
    // Both staged files live under 'src' — scanned once, not once per file.
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['security', 'secrets', '--action', 'scan', '-p', '/repo/src'])
    )
  })

  it('scans each distinct directory separately when staged files span multiple directories', () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: secretsTableStdout(1), stderr: '' }) // /repo/src
      .mockReturnValueOnce({
        status: 1,
        stdout: secretsTableStdout(1, [['AWS Access Key', 'b.ts:1', 'Critical']]),
        stderr: ''
      }) // /repo/lib
    const result = runSecretsScan(exec, '/repo', ['src/a.ts', 'lib/b.ts'])
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenNthCalledWith(1, 'npx', expect.arrayContaining(['-p', '/repo/src']))
    expect(exec).toHaveBeenNthCalledWith(2, 'npx', expect.arrayContaining(['-p', '/repo/lib']))
    expect(result.blocking).toBe(true)
    expect(result.message).toContain('b.ts:1')
  })

  it('blocks only for a finding whose Location matches a staged file, ignoring a pre-existing secret elsewhere in the same shared directory', () => {
    // Directory has two files' worth of findings, but only a.ts is staged.
    const exec = vi.fn().mockReturnValue({
      status: 1,
      stdout: secretsTableStdout(2, [
        ['AWS Access Key', 'a.ts:1', 'Critical'],
        ['AWS Access Key', 'b.ts:5', 'Critical']
      ]),
      stderr: ''
    })
    const result = runSecretsScan(exec, '/repo', ['src/a.ts'])
    expect(result.blocking).toBe(true)
    expect(result.warning).toBe(false)
    expect(result.message).toContain('a.ts:1')
    expect(result.message).not.toContain('b.ts:5')
  })

  it('does not block when the only findings in the scanned directory belong to files that are not staged', () => {
    const exec = vi.fn().mockReturnValue({
      status: 1,
      stdout: secretsTableStdout(2, [['AWS Access Key', 'b.ts:5', 'Critical']]),
      stderr: ''
    })
    const result = runSecretsScan(exec, '/repo', ['src/a.ts'])
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(false)
    expect(result.message).toBe('No secrets detected.')
  })

  it('warns (does not block) when the tool is unavailable', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'tool not found' })
    const result = runSecretsScan(exec, '/repo', ['src/a.ts'])
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(true)
    expect(result.message).toContain('Unable to scan')
    expect(result.message).toContain('tool not found')
    expect(exec).toHaveBeenCalled()
  })

  it('warns when some directories scan successfully and others fail', () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: secretsTableStdout(1), stderr: '' }) // /repo/src
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'connection error' }) // /repo/lib
    const result = runSecretsScan(exec, '/repo', ['src/a.ts', 'lib/b.ts'])
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(true)
    expect(result.message).toContain('Unable to scan')
    expect(result.message).toContain('connection error')
    expect(exec).toHaveBeenCalledTimes(2)
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

  it('warns (does not block) when the tool is unavailable', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'command not found' })
    const result = runComplexityRegression(exec, '/repo', ['src/a.ts'], baseline)
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(true)
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

  it('warns (does not block) when the tool is unavailable', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'command not found' })
    const result = runDependenciesRegression(exec, ['src/a.ts'], baseline)
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(true)
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

  /*
   * `runReportOnly` has no `blocking`/`warning` fields (it feeds `report`, a context artifact
   * for the agentic review — see `pre-commit-checks.ts`'s `runAllChecks`, which never `record()`s
   * it) so "warns, not blocking" doesn't literally apply here the way it does for the other
   * three functions in this file. What matters equally per Global Constraint #4 is that a tool
   * being unavailable degrades gracefully (empty/fallback output) instead of throwing.
   */
  it('degrades to empty output instead of throwing when the tool is unavailable', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'command not found' })
    expect(() => runReportOnly(exec, 'boundaries')).not.toThrow()
    expect(runReportOnly(exec, 'boundaries')).toEqual({ subcommand: 'boundaries', output: '' })
  })
})
