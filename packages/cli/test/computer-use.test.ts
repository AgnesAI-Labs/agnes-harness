import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import {
  computerUseOperationCommand,
  computerUsePermissionsGrantCommand,
  computerUsePermissionsStatusCommand,
  computerUseRescueCommand,
  computerUseStatusCommand,
  doctorComputerUseCommand,
  validateComputerUseOperationArgs,
  validateComputerUseRescueArgs,
  validateComputerUseStatusArgs,
  validateDoctorComputerUseArgs,
} from '../src/commands/computer-use.js'
import { UsageError } from '../src/errors.js'

const report = {
  schemaVersion: 1 as const,
  status: 'blocked' as const,
  admission: { state: 'blocked' as const, reason: 'p0-evidence-incomplete' as const },
  runtime: { state: 'not-started' as const, startAttempted: false as const },
  blockers: [
    'release-provenance-incomplete' as const,
    'compatibility-evidence-incomplete' as const,
    'platform-acceptance-incomplete' as const,
  ],
}

const permissionsReport = {
  schemaVersion: 1 as const,
  status: 'unavailable' as const,
  admission: { state: 'blocked' as const, reason: 'p0-evidence-incomplete' as const },
  probe: { state: 'not-run' as const, reason: 'production-driver-admission-disabled' as const },
}

const doctorReport = {
  schemaVersion: 1 as const,
  status: 'blocked' as const,
  admission: { state: 'blocked' as const, reason: 'p0-evidence-incomplete' as const },
  checks: { state: 'not-run' as const, reason: 'production-driver-admission-disabled' as const },
}

const mutationStatus = {
  activationReady: false as const,
  recoveryReady: true as const,
  blockers: ['trusted-directory-handle-unavailable' as const],
}

type TestCall = ReturnType<typeof vi.fn> & (<T>(method: string, params: unknown) => Promise<T>)

const client = () => ({
  call: vi.fn(async (method: string) => {
    if (method === '_agnes/v1/computerUse.status') return report
    if (method === '_agnes/v1/computerUse.permissions.status') return permissionsReport
    if (method === '_agnes/v1/computerUse.doctor') return doctorReport
    throw new Error(`unexpected method ${method}`)
  }) as TestCall,
})

describe('computer-use CLI status', () => {
  it('runs standalone rescue without RPC and refuses a live daemon', async () => {
    const parsed = parseArgs([
      'computer-use',
      'rescue',
      'repair',
      '--profile',
      'safe',
      '--cwd',
      'D:\\work',
      '--data-dir',
      'D:\\agnes\\rescue-data',
      '--json',
    ])
    expect(validateComputerUseRescueArgs(parsed)).toBe('repair')
    expect(parsed.dataDir).toBe('D:\\agnes\\rescue-data')
    const rescue = {
      schemaVersion: 1 as const,
      action: 'repair' as const,
      platform: 'win32' as const,
      status: 'completed' as const,
      generation: 2,
      activeVersion: '0.28.1',
      outcome: 'repaired' as const,
    }
    const run = vi.fn(async () => rescue)
    const result = await computerUseRescueCommand(parsed, {
      dataDir: 'D:\\agnes\\data',
      daemonRunning: false,
      run,
    })
    expect(run).toHaveBeenCalledWith({ action: 'repair', dataDir: 'D:\\agnes\\data' })
    expect(JSON.parse(result.text)).toEqual(rescue)
    expect(result.exitCode).toBe(0)
    await expect(
      computerUseRescueCommand(parsed, {
        dataDir: 'D:\\agnes\\data',
        daemonRunning: true,
        run,
      }),
    ).rejects.toThrow(/live daemon/)
    expect(run).toHaveBeenCalledOnce()
    const status = { ...rescue, action: 'status' as const, status: 'ready' as const }
    const statusRun = vi.fn(async () => status)
    await expect(
      computerUseRescueCommand(parseArgs(['computer-use', 'rescue', 'status']), {
        dataDir: 'D:\\agnes\\data',
        daemonRunning: true,
        run: statusRun,
      }),
    ).resolves.toMatchObject({ report: status })
  })

  it('rejects malformed rescue requests before maintenance dispatch', () => {
    for (const args of [
      ['computer-use', 'rescue'],
      ['computer-use', 'rescue', 'unknown'],
      ['computer-use', 'rescue', 'status', 'extra'],
      ['computer-use', 'rescue', 'install', '--upgrade'],
      ['computer-use', 'rescue', 'repair', '--connect', 'remote'],
      ['computer-use', 'status', '--data-dir', 'D:\\agnes\\data'],
    ])
      expect(() => validateComputerUseRescueArgs(parseArgs(args))).toThrow(UsageError)
  })

  it('calls only the authenticated read-only status RPC and preserves JSON exactly', async () => {
    const rpc = client()
    const result = await computerUseStatusCommand(parseArgs(['computer-use', 'status', '--json']), rpc)
    expect(rpc.call).toHaveBeenCalledOnce()
    expect(rpc.call).toHaveBeenCalledWith('_agnes/v1/computerUse.status', {})
    expect(JSON.parse(result.text)).toEqual(report)
    expect(result.report).toEqual(report)
    expect(result.exitCode).toBe(1)
  })

  it('renders the blocked admission, inert runtime, and every evidence blocker', async () => {
    const rpc = client()
    rpc.call.mockResolvedValueOnce({ ...doctorReport, lockedPackageMutations: mutationStatus })
    const result = await doctorComputerUseCommand(parseArgs(['doctor', 'computer-use']), rpc)
    expect(result.text).toContain('computer-use doctor: blocked')
    expect(result.text).toContain('admission: blocked (p0-evidence-incomplete)')
    expect(result.text).toContain('checks: not-run (production-driver-admission-disabled)')
    expect(result.text).toContain('locked-package mutations: activation=false recovery=true')
    expect(result.text).toContain('trusted-directory-handle-unavailable')
  })

  it('renders missing mutation status as unknown rather than ready', async () => {
    const rpc = client()
    const status = await computerUseStatusCommand(parseArgs(['computer-use', 'status']), rpc)
    expect(status.text).toContain('locked-package mutations: unknown')
  })

  it('rejects probes, trailing arguments, and repair before any RPC', async () => {
    for (const args of [
      ['computer-use', 'status', 'probe'],
      ['computer-use', 'status', '--repair'],
      ['computer-use', 'status', '--continue'],
      ['computer-use', 'status', '--profile', 'other'],
      ['computer-use', 'status', '--raw'],
    ]) {
      const parsed = parseArgs(args)
      expect(() => validateComputerUseStatusArgs(parsed)).toThrow(UsageError)
      const rpc = client()
      await expect(computerUseStatusCommand(parsed, rpc)).rejects.toThrow(UsageError)
      expect(rpc.call).not.toHaveBeenCalled()
    }
    const rpc = client()
    await expect(
      doctorComputerUseCommand(parseArgs(['doctor', 'computer-use', '--repair']), rpc),
    ).rejects.toThrow(/read-only/)
    expect(rpc.call).not.toHaveBeenCalled()
    for (const args of [
      ['doctor', 'computer-use', '--continue'],
      ['doctor', 'computer-use', '--profile', 'other'],
      ['doctor', 'computer-use', '--raw'],
    ])
      expect(() => validateDoctorComputerUseArgs(parseArgs(args))).toThrow(/only --json/)
  })

  it('starts an explicit install or update and polls bounded structured progress', async () => {
    const queued = {
      schemaVersion: 1 as const,
      status: 'found' as const,
      operationId: 'cu-install',
      kind: 'update' as const,
      state: 'queued' as const,
      phase: 'queued' as const,
      startedAtMs: 1,
      updatedAtMs: 1,
    }
    const running = { ...queued, state: 'running' as const, phase: 'installing' as const, updatedAtMs: 2 }
    const completed = {
      ...queued,
      state: 'succeeded' as const,
      phase: 'complete' as const,
      updatedAtMs: 3,
      outcome: 'installed' as const,
    }
    const call = vi
      .fn()
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completed) as TestCall
    const parsed = parseArgs(['computer-use', 'install', '--upgrade', '--json'])
    expect(validateComputerUseOperationArgs(parsed)).toEqual({ action: 'start', kind: 'update' })
    const result = await computerUseOperationCommand(parsed, { call }, { wait: async () => undefined })
    expect(call).toHaveBeenNthCalledWith(1, '_agnes/v1/computerUse.operation.start', { kind: 'update' })
    expect(call).toHaveBeenNthCalledWith(2, '_agnes/v1/computerUse.operation.status', {
      operationId: 'cu-install',
    })
    expect(call).toHaveBeenNthCalledWith(3, '_agnes/v1/computerUse.operation.status', {
      operationId: 'cu-install',
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.text)).toEqual(completed)
  })

  it('supports restart, status and cancellation while rejecting misplaced upgrade flags', async () => {
    expect(validateComputerUseOperationArgs(parseArgs(['computer-use', 'restart']))).toEqual({
      action: 'start',
      kind: 'restart',
    })
    expect(validateComputerUseOperationArgs(parseArgs(['computer-use', 'operation', 'cu-one']))).toEqual({
      action: 'status',
      operationId: 'cu-one',
    })
    expect(validateComputerUseOperationArgs(parseArgs(['computer-use', 'cancel', 'cu-one']))).toEqual({
      action: 'cancel',
      operationId: 'cu-one',
    })
    expect(() =>
      validateComputerUseOperationArgs(parseArgs(['computer-use', 'restart', '--upgrade'])),
    ).toThrow(/only by computer-use install/)
    const notFound = { schemaVersion: 1 as const, status: 'not-found' as const }
    const call = vi.fn(async () => notFound) as TestCall
    const result = await computerUseOperationCommand(parseArgs(['computer-use', 'cancel', 'cu-one']), {
      call,
    })
    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.cancel', { operationId: 'cu-one' })
    expect(result.exitCode).toBe(2)
  })

  it('reads authenticated permissions status without claiming platform permission evidence', async () => {
    const rpc = client()
    const result = await computerUsePermissionsStatusCommand(
      parseArgs(['computer-use', 'permissions', 'status', '--json']),
      rpc,
    )
    expect(rpc.call).toHaveBeenCalledWith('_agnes/v1/computerUse.permissions.status', {})
    expect(JSON.parse(result.text)).toEqual(permissionsReport)
    expect(result.exitCode).toBe(1)
  })

  it('returns success when both macOS TCC grants were verified', async () => {
    const granted = {
      schemaVersion: 1 as const,
      status: 'granted' as const,
      admission: { state: 'ready' as const, reason: 'macos-verified-driver' as const },
      probe: {
        state: 'passed' as const,
        reason: 'macos-tcc-permissions-granted' as const,
        accessibility: true as const,
        screenRecording: true as const,
      },
    }
    const result = await computerUsePermissionsStatusCommand(
      parseArgs(['computer-use', 'permissions', 'status', '--json']),
      { call: vi.fn(async () => granted) as TestCall },
    )
    expect(result.exitCode).toBe(0)
    expect(result.report).toEqual(granted)
  })

  it('runs the explicit local permissions grant RPC and returns its verified status', async () => {
    const granted = {
      schemaVersion: 1 as const,
      status: 'granted' as const,
      admission: { state: 'ready' as const, reason: 'macos-verified-driver' as const },
      probe: {
        state: 'passed' as const,
        reason: 'macos-tcc-permissions-granted' as const,
        accessibility: true as const,
        screenRecording: true as const,
      },
    }
    const call = vi.fn(async () => granted) as TestCall
    const result = await computerUsePermissionsGrantCommand(
      parseArgs(['computer-use', 'permissions', 'grant', '--json']),
      { call },
    )
    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.permissions.grant', {})
    expect(result.exitCode).toBe(0)
  })

  it('sends filtered doctor selectors to the authenticated closed RPC', async () => {
    const parsed = parseArgs(['doctor', 'computer-use', '--include', 'binary', '--skip', 'display', '--json'])
    const rpc = client()
    const result = await doctorComputerUseCommand(parsed, rpc)
    expect(rpc.call).toHaveBeenCalledWith('_agnes/v1/computerUse.doctor', {
      include: ['binary'],
      skip: ['display'],
    })
    expect(JSON.parse(result.text)).toEqual(doctorReport)
    expect(result.exitCode).toBe(1)
  })

  it('uses stable doctor exit codes for failed and unreachable live checks', async () => {
    const failed = {
      schemaVersion: 1 as const,
      status: 'failed' as const,
      admission: { state: 'ready' as const, reason: 'windows-verified-driver' as const },
      checks: {
        state: 'failed' as const,
        reason: 'windows-driver-health-or-identity-failed' as const,
      },
    }
    const unreachable = {
      schemaVersion: 1 as const,
      status: 'unreachable' as const,
      admission: { state: 'ready' as const, reason: 'macos-verified-driver' as const },
      checks: { state: 'unavailable' as const, reason: 'live-driver-doctor-unavailable' as const },
    }
    for (const [value, exitCode] of [
      [failed, 1],
      [unreachable, 2],
    ] as const) {
      const call = vi.fn(async () => value) as TestCall
      const result = await doctorComputerUseCommand(parseArgs(['doctor', 'computer-use', '--json']), {
        call,
      })
      expect(result.exitCode).toBe(exitCode)
      expect(JSON.parse(result.text)).toEqual(value)
    }
  })
})
