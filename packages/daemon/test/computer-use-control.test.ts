import { describe, expect, it, vi } from 'vitest'
import {
  createBlockedComputerUseControlPlane,
  projectComputerUseDriverLockBlockers,
} from '../src/local/computer-use-control.js'

const local = { authKind: 'local' as const, credentialKind: 'local' as const }

describe('blocked computer-use control plane', () => {
  it.each([
    'feature-disabled',
    'platform-unsupported',
    'driver-not-prepared',
    'driver-preparing',
    'driver-prepare-failed',
  ])('reports %s without attempting to prepare a driver', async (availability) => {
    const status = vi.fn(() => ({ availability }))
    const control = createBlockedComputerUseControlPlane(undefined, { status })
    await expect(control.status(local, {})).resolves.toEqual({
      schemaVersion: 1,
      status: 'blocked',
      admission: { state: 'blocked', reason: 'runtime-unavailable' },
      runtime: { state: 'not-started', startAttempted: false },
      blockers: [availability],
    })
    expect(status).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['artifacts:targets', 'release-provenance-incomplete'],
    ['artifact:linux:signature', 'release-provenance-incomplete'],
    ['lkg:status', 'release-provenance-incomplete'],
    ['lab:linuxWayland', 'platform-acceptance-incomplete'],
    ['lkg:platform-verification', 'platform-acceptance-incomplete'],
    ['fixture:manifest', 'compatibility-evidence-incomplete'],
    ['schema:invalid', 'compatibility-evidence-incomplete'],
    ['unknown:future-gate', 'compatibility-evidence-incomplete'],
  ] as const)('projects fixed driver blocker %s to %s', (source, expected) => {
    expect(projectComputerUseDriverLockBlockers([source])).toEqual([expected])
  })

  it('projects the fixed Host admission blockers without attempting runtime startup', async () => {
    const control = createBlockedComputerUseControlPlane()
    await expect(control.status(local, {})).resolves.toEqual({
      schemaVersion: 1,
      status: 'blocked',
      admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
      runtime: { state: 'not-started', startAttempted: false },
      blockers: [
        'release-provenance-incomplete',
        'compatibility-evidence-incomplete',
        'platform-acceptance-incomplete',
      ],
    })
  })

  it('reports read-only locked-package mutation readiness without weakening P0 admission', async () => {
    const status = {
      status: () => ({
        activationReady: false,
        recoveryReady: true,
        blockers: ['trusted-directory-handle-unavailable'],
      }),
    }
    const control = createBlockedComputerUseControlPlane(status)
    await expect(control.status(local, {})).resolves.toMatchObject({
      status: 'blocked',
      admission: { state: 'blocked' },
      lockedPackageMutations: {
        activationReady: false,
        recoveryReady: true,
        blockers: ['trusted-directory-handle-unavailable'],
      },
    })
    await expect(control.doctor(local, {})).resolves.toMatchObject({
      status: 'blocked',
      checks: { state: 'not-run' },
      lockedPackageMutations: {
        activationReady: false,
        recoveryReady: true,
        blockers: ['trusted-directory-handle-unavailable'],
      },
    })
  })

  it('reports platform-scoped Windows admission only from the Host verified status source', async () => {
    const runtime = {
      status: () => ({
        platform: 'win32',
        version: '0.28.1',
        publisher: 'Cua AI, Inc.',
        activeSessions: 1,
        startAttempted: true,
      }),
      doctor: async () => undefined,
      setSessionYolo: async () => undefined,
    }
    const control = createBlockedComputerUseControlPlane(undefined, runtime)
    await expect(control.status(local, {})).resolves.toEqual({
      schemaVersion: 1,
      status: 'ready',
      admission: { state: 'ready', reason: 'windows-verified-driver' },
      runtime: { state: 'running', startAttempted: true, activeSessions: 1 },
      blockers: [],
      driver: { platform: 'win32', version: '0.28.1', publisher: 'Cua AI, Inc.' },
    })
    await expect(control.permissionsStatus(local, {})).resolves.toMatchObject({
      status: 'not-required',
      probe: { state: 'passed', reason: 'windows-no-os-grant-required' },
    })
    await expect(control.doctor(local, {})).resolves.toMatchObject({
      status: 'ready',
      checks: { state: 'passed', reason: 'windows-driver-health-and-identity-verified' },
    })
  })

  it('reports macOS platform readiness with daemon-attributed TCC state', async () => {
    const doctor = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('mac health failed'))
    const runtime = {
      status: () => ({
        platform: 'darwin',
        version: '0.28.1',
        publisher: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        activeSessions: 0,
        startAttempted: false,
      }),
      doctor,
      permissionsStatus: async () => ({ accessibility: true, screenRecording: false }),
      permissionsGrant: async () => ({ accessibility: true, screenRecording: true }),
      setSessionYolo: async () => undefined,
    }
    const control = createBlockedComputerUseControlPlane(undefined, runtime)
    await expect(control.status(local, {})).resolves.toMatchObject({
      status: 'ready',
      admission: { state: 'ready', reason: 'macos-verified-driver' },
      runtime: { state: 'idle', activeSessions: 0 },
      driver: { platform: 'darwin', version: '0.28.1' },
    })
    await expect(control.doctor(local, {})).resolves.toMatchObject({
      status: 'ready',
      checks: { state: 'passed', reason: 'macos-driver-health-and-identity-verified' },
    })
    await expect(control.doctor(local, {})).resolves.toMatchObject({
      status: 'failed',
      admission: { state: 'ready', reason: 'macos-verified-driver' },
      checks: { state: 'failed', reason: 'macos-driver-health-or-identity-failed' },
    })
    await expect(control.permissionsStatus(local, {})).resolves.toEqual({
      schemaVersion: 1,
      status: 'required',
      admission: { state: 'ready', reason: 'macos-verified-driver' },
      probe: {
        state: 'passed',
        reason: 'macos-tcc-permissions-missing',
        accessibility: true,
        screenRecording: false,
      },
    })
    await expect(control.permissionsGrant(local, {})).resolves.toMatchObject({
      status: 'granted',
      probe: { accessibility: true, screenRecording: true },
    })
  })

  it('reports granted only when both macOS TCC permissions are present', async () => {
    const control = createBlockedComputerUseControlPlane(undefined, {
      status: () => ({
        platform: 'darwin',
        version: '0.28.1',
        publisher: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        activeSessions: 0,
        startAttempted: true,
      }),
      permissionsStatus: async () => ({ accessibility: true, screenRecording: true }),
    })
    await expect(control.permissionsStatus(local, {})).resolves.toMatchObject({
      status: 'granted',
      probe: {
        state: 'passed',
        reason: 'macos-tcc-permissions-granted',
        accessibility: true,
        screenRecording: true,
      },
    })
  })

  it('runs a fresh Host doctor and never turns cached readiness into a false pass', async () => {
    const failure = new Error('driver health changed after startup')
    const doctor = vi.fn().mockRejectedValue(failure)
    const control = createBlockedComputerUseControlPlane(undefined, {
      status: () => ({
        platform: 'win32',
        version: '0.28.1',
        publisher: 'Cua AI, Inc.',
        activeSessions: 0,
        startAttempted: true,
      }),
      doctor,
    })

    await expect(control.status(local, {})).resolves.toMatchObject({ status: 'ready' })
    await expect(control.doctor(local, {})).resolves.toMatchObject({
      status: 'failed',
      checks: { state: 'failed', reason: 'windows-driver-health-or-identity-failed' },
    })
    expect(doctor).toHaveBeenCalledOnce()
  })

  it('reports a missing live doctor as unreachable without exposing internals', async () => {
    const control = createBlockedComputerUseControlPlane(undefined, {
      status: () => ({
        platform: 'darwin',
        version: '0.28.1',
        publisher: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        activeSessions: 0,
        startAttempted: true,
      }),
    })
    await expect(control.doctor(local, {})).resolves.toEqual({
      schemaVersion: 1,
      status: 'unreachable',
      admission: { state: 'ready', reason: 'macos-verified-driver' },
      checks: { state: 'unavailable', reason: 'live-driver-doctor-unavailable' },
    })
  })

  it('exposes authenticated bounded driver operations without leaking task failures', async () => {
    const start = vi.fn(() => ({
      operationId: 'cu-one',
      kind: 'update',
      state: 'queued',
      phase: 'queued',
      startedAtMs: 10,
      updatedAtMs: 10,
    }))
    const status = vi.fn(() => ({
      operationId: 'cu-one',
      kind: 'update',
      state: 'succeeded',
      phase: 'complete',
      startedAtMs: 10,
      updatedAtMs: 20,
      outcome: 'installed',
    }))
    const cancel = vi.fn(() => undefined)
    const control = createBlockedComputerUseControlPlane(undefined, {
      status: () => ({
        platform: 'win32',
        version: '0.28.1',
        publisher: 'Cua AI, Inc.',
        activeSessions: 0,
        startAttempted: false,
      }),
      operationStart: start,
      operationStatus: status,
      operationCancel: cancel,
    })

    await expect(control.operationStart(local, { kind: 'update' })).resolves.toMatchObject({
      status: 'found',
      operationId: 'cu-one',
      state: 'queued',
    })
    expect(start).toHaveBeenCalledWith('update')
    await expect(control.operationStatus(local, { operationId: 'cu-one' })).resolves.toMatchObject({
      status: 'found',
      state: 'succeeded',
      outcome: 'installed',
    })
    await expect(control.operationCancel(local, { operationId: 'cu-missing' })).resolves.toEqual({
      schemaVersion: 1,
      status: 'not-found',
    })
    await expect(
      control.operationStart({ authKind: 'jwt', credentialKind: 'jwt' }, { kind: 'install' }),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  })

  it('rejects malformed or contradictory Host operation snapshots', async () => {
    const control = createBlockedComputerUseControlPlane(undefined, {
      status: () => ({
        platform: 'darwin',
        version: '0.28.1',
        publisher: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        activeSessions: 0,
        startAttempted: false,
      }),
      operationStatus: () => ({
        operationId: 'cu-bad',
        kind: 'restart',
        state: 'succeeded',
        phase: 'complete',
        startedAtMs: 20,
        updatedAtMs: 10,
        error: 'private path',
      }),
    })
    await expect(control.operationStatus(local, {})).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    await expect(control.operationStart(local, { kind: 'repair' })).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })

    const mismatched = createBlockedComputerUseControlPlane(undefined, {
      status: () => ({
        platform: 'win32',
        version: '0.28.1',
        publisher: 'Cua AI, Inc.',
        activeSessions: 0,
        startAttempted: false,
      }),
      operationStatus: () => ({
        operationId: 'cu-wrong-outcome',
        kind: 'restart',
        state: 'succeeded',
        phase: 'complete',
        startedAtMs: 1,
        updatedAtMs: 2,
        outcome: 'installed',
      }),
    })
    await expect(mismatched.operationStatus(local, {})).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
  })

  it('passes normalized include and skip selectors to the live Host doctor', async () => {
    const doctor = vi.fn().mockResolvedValue(undefined)
    const control = createBlockedComputerUseControlPlane(undefined, {
      status: () => ({
        platform: 'win32',
        version: '0.28.1',
        publisher: 'Cua AI, Inc.',
        activeSessions: 0,
        startAttempted: true,
      }),
      doctor,
    })

    await expect(
      control.doctor(local, { include: ['binary_version'], skip: ['session_active'] }),
    ).resolves.toMatchObject({ status: 'ready' })
    expect(doctor).toHaveBeenCalledWith({
      include: ['binary_version'],
      skip: ['session_active'],
    })
  })

  it('fails the macOS permission status closed when its live probe is absent or malformed', async () => {
    const base = {
      status: () => ({
        platform: 'darwin',
        version: '0.28.1',
        publisher: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        activeSessions: 0,
        startAttempted: false,
      }),
    }
    for (const runtime of [base, { ...base, permissionsStatus: async () => ({ accessibility: true }) }])
      await expect(
        createBlockedComputerUseControlPlane(undefined, runtime).permissionsStatus(local, {}),
      ).resolves.toMatchObject({
        status: 'unknown',
        probe: { state: 'failed', reason: 'macos-tcc-probe-failed' },
      })
  })

  it('does not report granted when the explicit macOS permission flow fails', async () => {
    const control = createBlockedComputerUseControlPlane(undefined, {
      status: () => ({
        platform: 'darwin',
        version: '0.28.1',
        publisher: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        activeSessions: 0,
        startAttempted: false,
      }),
      permissionsStatus: async () => ({ accessibility: true, screenRecording: true }),
      permissionsGrant: async () => {
        throw new Error('direct capture denied')
      },
    })
    await expect(control.permissionsGrant(local, {})).resolves.toMatchObject({
      status: 'unknown',
      probe: { state: 'failed', reason: 'macos-tcc-probe-failed' },
    })
  })

  it('fails closed when a purported production status source is malformed', async () => {
    const control = createBlockedComputerUseControlPlane(undefined, {
      status: () => ({
        platform: 'win32',
        version: '0.28.1',
        publisher: 'Cua AI, Inc.',
        activeSessions: -1,
        startAttempted: true,
      }),
    })
    await expect(control.status(local, {})).resolves.toMatchObject({ status: 'blocked' })
  })

  it('treats absent or malformed mutation status as unknown, never ready', async () => {
    await expect(createBlockedComputerUseControlPlane().status(local, {})).resolves.not.toHaveProperty(
      'lockedPackageMutations',
    )
    const touched = { value: false }
    const hostile = Object.freeze({
      status: () =>
        Object.defineProperty({}, 'activationReady', {
          enumerable: true,
          get() {
            touched.value = true
            return true
          },
        }),
    })
    await expect(createBlockedComputerUseControlPlane(hostile).status(local, {})).resolves.not.toHaveProperty(
      'lockedPackageMutations',
    )
    expect(touched.value).toBe(false)
    let sourceTouched = false
    const accessorSource = Object.defineProperty({}, 'status', {
      enumerable: true,
      get() {
        sourceTouched = true
        return () => ({ activationReady: true, recoveryReady: true, blockers: [] })
      },
    })
    await expect(
      createBlockedComputerUseControlPlane(accessorSource as never).status(local, {}),
    ).resolves.not.toHaveProperty('lockedPackageMutations')
    expect(sourceTouched).toBe(false)
  })

  it('returns closed permission status without platform or permission claims', async () => {
    const control = createBlockedComputerUseControlPlane()
    await expect(control.permissionsStatus(local, {})).resolves.toEqual({
      schemaVersion: 1,
      status: 'unavailable',
      admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
      probe: { state: 'not-run', reason: 'production-driver-admission-disabled' },
    })
  })

  it('accepts bounded doctor filters while preserving driver-owned skip-wins overlap', async () => {
    const control = createBlockedComputerUseControlPlane()
    await expect(
      control.doctor(local, {
        include: ['binary_version', 'driver-check', 'tcc_accessibility'],
        skip: ['tcc_accessibility', 'bundle_identity'],
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      status: 'blocked',
      admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
      checks: { state: 'not-run', reason: 'production-driver-admission-disabled' },
    })
  })

  it.each([
    [{ probe: true }],
    [{ repair: true }],
    [{ include: undefined }],
    [{ include: 'binary_version' }],
    [{ include: [] }],
    [{ include: [''] }],
    [{ include: ['TCC'] }],
    [{ include: ['../capture'] }],
    [{ include: ['binary', 'binary'] }],
    [{ include: Array.from({ length: 33 }, (_, index) => `check_${index}`) }],
    [Object.assign(Object.create({ inherited: true }), {})],
  ])('rejects malformed or unbounded doctor params %#', async (params) => {
    await expect(createBlockedComputerUseControlPlane().doctor(local, params)).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
  })

  it('rejects sparse arrays and accessor-backed fields without evaluating accessors', async () => {
    const sparse = new Array(1)
    const decorated = ['binary_version']
    Object.defineProperty(decorated, 'hidden', { value: 'secret' })
    let evaluated = false
    const accessor = Object.defineProperty({}, 'include', {
      enumerable: true,
      get() {
        evaluated = true
        return ['binary_version']
      },
    })
    const control = createBlockedComputerUseControlPlane()
    await expect(control.doctor(local, { include: sparse })).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    await expect(control.doctor(local, { include: decorated })).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    await expect(control.doctor(local, accessor)).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    expect(evaluated).toBe(false)
  })

  it.each([
    [{}],
    [{ authKind: 'jwt' as const, credentialKind: 'jwt' as const }],
    [{ authKind: 'source-auth' as const, credentialKind: 'channel' as const }],
    [{ authKind: 'surface' as const, credentialKind: 'sso' as const }],
    [{ authKind: 'local' as const, credentialKind: 'sso' as const }],
  ])('requires authenticated local-owner authority %#', async (authority) => {
    const control = createBlockedComputerUseControlPlane()
    await expect(control.doctor(authority, {})).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(control.permissionsStatus(authority, {})).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(control.permissionsGrant(authority, {})).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('rejects lifecycle-like permission params and exposes no lifecycle methods', async () => {
    const control = createBlockedComputerUseControlPlane()
    for (const params of [{ grant: true }, { probe: true }, { repair: true }, { start: true }])
      await expect(control.permissionsStatus(local, params)).rejects.toMatchObject({
        data: { code: 'INVALID_PARAMS' },
      })
    expect(Object.keys(control).sort()).toEqual([
      'doctor',
      'operationCancel',
      'operationStart',
      'operationStatus',
      'permissionsGrant',
      'permissionsStatus',
      'status',
    ])
  })
})
