import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertMeasuredSet,
  assertStateBackend,
  assertToolWindows,
  BASELINE_ORACLE,
  buildReport,
  type CommitRecord,
  classifyCommits,
  kernelSessionCount,
  MEASURED_SCENARIOS,
  reconcileAuthoritative,
  runBaseline,
  runCandidate,
  type Sample,
} from './bench-runtime-control.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function commit(over: Partial<CommitRecord> = {}): CommitRecord {
  return {
    method: 'dispatchAdmission',
    requestId: 'admission-1',
    wrote: true,
    bucket: 'tool',
    toolKeys: ['read:0'],
    txMs: 0.1,
    callMs: 0.2,
    ...over,
  }
}

describe('runtime control meter', () => {
  it('fails when a counter drops an ack or records an intake the database does not have', () => {
    const counted = [
      commit({ wrote: true }),
      commit({ requestId: 'ack-1', method: 'ackOutbox', bucket: 'shared', toolKeys: [] }),
    ]
    expect(() =>
      reconcileAuthoritative(
        counted.filter((row) => row.method !== 'ackOutbox'),
        2,
      ),
    ).toThrow(/does not match attested/)
    expect(() =>
      reconcileAuthoritative([...counted, commit({ requestId: 'intake-extra', method: 'intakeReceipt' })], 2),
    ).toThrow(/does not match attested/)
    reconcileAuthoritative(counted, 2)
  })

  it('fails when a tool intake or an outbox ack is missing', () => {
    const full: CommitRecord[] = [
      commit(),
      commit({ method: 'commitControl', requestId: 'mark-read:0' }),
      commit({ method: 'intakeReceipt', requestId: 'intake-read:0' }),
      commit({ method: 'claimOutbox', requestId: 'claim-0', bucket: 'shared', toolKeys: [] }),
      commit({ method: 'ackOutbox', requestId: 'ack-0', bucket: 'shared', toolKeys: [] }),
    ]
    assertToolWindows(full, ['read:0'])
    expect(() =>
      assertToolWindows(
        full.filter((row) => row.method !== 'intakeReceipt'),
        ['read:0'],
      ),
    ).toThrow(/missing intakeReceipt/)
    expect(() =>
      assertToolWindows(
        full.filter((row) => row.method !== 'ackOutbox'),
        ['read:0'],
      ),
    ).toThrow(/missing ack/)
  })

  it('fails when a k scenario is absent and keeps the unmeasured names out of that check', () => {
    expect(() => assertMeasuredSet(['k1', 'k4', 'k16', 'chat'])).toThrow(/missing scenario k8/)
    assertMeasuredSet([...MEASURED_SCENARIOS])
  })

  it('fails when the candidate is handed the legacy kernel', async () => {
    expect(() => assertStateBackend({ kind: 'legacy-kernel', openSession: () => undefined })).toThrow(
      /legacy kernel/,
    )
    await expect(runCandidate('k1', { openSession: () => undefined })).rejects.toThrow(/legacy kernel/)
    assertStateBackend(undefined)
  })

  it('splits a shared tool commit into an amortized share', () => {
    const classified = classifyCommits([
      commit({ requestId: 'shared-dispatch', toolKeys: ['read:0', 'read:1'] }),
      commit({ method: 'commitControl', requestId: 'mark-0', toolKeys: ['read:0'] }),
      commit({ method: 'intakeReceipt', requestId: 'intake-0', toolKeys: ['read:0'] }),
      commit({ method: 'commitControl', requestId: 'mark-1', toolKeys: ['read:1'] }),
      commit({ method: 'intakeReceipt', requestId: 'intake-1', toolKeys: ['read:1'] }),
      commit({ method: 'advanceRun', requestId: 'advance', bucket: 'shared', toolKeys: [] }),
    ])
    expect(classified.tRound).toBe(6)
    expect(classified.tShared).toBe(1)
    expect(classified.tools.map((tool) => tool.amortized)).toEqual([2.5, 2.5])
    expect(classified.tTool).toBe(3)
  })

  it('reproduces the legacy driver counts for every measured scenario', async () => {
    const tsx = join(root, 'node_modules/tsx/dist/cli.mjs')
    const output = execFileSync(
      process.execPath,
      [
        tsx,
        join(root, 'tools/bench-ledger-write.ts'),
        ...MEASURED_SCENARIOS.flatMap((name) => ['--scenario', name]),
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )
    const legacy = new Map(
      output
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as { scenario: string; commits: number; rows: number; opCellBytes: number },
        )
        .map((row) => [row.scenario, row]),
    )
    for (const name of MEASURED_SCENARIOS) {
      const sample = await runBaseline(name)
      const expected = BASELINE_ORACLE[name]
      const fromDriver = legacy.get(name)
      expect(sample.commits, name).toBe(expected.commits)
      expect(sample.rows, name).toBe(expected.rows)
      expect(sample.opCellBytes, name).toBe(expected.opCellBytes)
      expect(fromDriver).toMatchObject(expected)
      expect(sample.backend).toBe('legacy-kernel')
    }
  }, 120_000)

  it('runs the state path for every measured scenario and keeps the kernel closed', async () => {
    const before = kernelSessionCount()
    const samples: Sample[] = []
    for (const name of MEASURED_SCENARIOS) samples.push(await runCandidate(name))
    expect(kernelSessionCount()).toBe(before)
    for (const sample of samples) {
      expect(sample.backend).toBe('state')
      expect(sample.commitMs.total).toBeGreaterThan(0)
      expect(sample.callMs?.total).toBeGreaterThanOrEqual(sample.commitMs.total)
      expect(sample.bytes?.providerState).toEqual({
        present: false,
        note: 'this prototype stores no ProviderState record; action.providerStateId stays null',
      })
      expect(sample.timingNote).toContain('BEGIN')
      if (sample.scenario === 'chat') expect(sample.tTool).toBe(0)
      else expect(sample.tTool).toBe(3)
      expect(sample.commits).toBe(sample.tRound)
    }
    const report = buildReport(
      [
        ...samples,
        ...MEASURED_SCENARIOS.map(
          (name) =>
            ({
              mode: 'baseline',
              scenario: name,
              status: 'measured',
              pageSize: samples[0]?.pageSize ?? 4096,
              commits: BASELINE_ORACLE[name].commits,
              rows: BASELINE_ORACLE[name].rows,
              opCellBytes: BASELINE_ORACLE[name].opCellBytes,
              walBytes: 1,
              walSegments: 1,
              walMaxFrames: 1,
              commitMs: { p50: 1, p95: 1, max: 1, total: 1 },
              wallMs: 1,
              backend: 'legacy-kernel',
            }) satisfies Sample,
        ),
      ],
      1,
    )
    expect(report.unmeasured).toEqual(['approval-k1', 'nested-m50+approval+abort'])
    expect(report.gates.toolCommits.pass).toBe(true)
    expect(() =>
      buildReport(
        samples.filter((sample) => sample.scenario !== 'k8'),
        1,
      ),
    ).toThrow(/missing scenario k8/)
  }, 120_000)
})
