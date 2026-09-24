// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ComputerUseStatusClient,
  createComputerUseStatusController as createController,
} from '../src/computer-use.js'

const controllers: ReturnType<typeof createController>[] = []
const createComputerUseStatusController = (...args: Parameters<typeof createController>) => {
  const controller = createController(...args)
  controllers.push(controller)
  return controller
}

beforeEach(() => {
  document.body.innerHTML = `
    <strong id="computer-use-state"></strong>
    <p id="computer-use-summary"></p>
    <p id="computer-use-runtime"></p>
    <ul id="computer-use-blockers"></ul>
    <button id="computer-use-refresh"></button>
    <strong id="computer-use-permission-state"></strong>
    <p id="computer-use-permission-summary"></p>
    <button id="computer-use-permission-grant"></button>
    <strong id="computer-use-doctor-state"></strong>
    <p id="computer-use-doctor-summary"></p>
    <button id="computer-use-doctor-run"></button>
    <strong id="computer-use-operation-state"></strong>
    <p id="computer-use-operation-summary"></p>
    <button id="computer-use-install"></button>
    <button id="computer-use-update"></button>
    <button id="computer-use-restart"></button>
    <button id="computer-use-operation-refresh"></button>
    <button id="computer-use-operation-cancel"></button>
  `
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  document.body.replaceChildren()
})

describe('Computer Use status', () => {
  it('discovers a new preparation after the previous operation failed', async () => {
    let preparing = false
    let finishWait!: () => void
    const waiting = new Promise<void>((resolve) => {
      finishWait = resolve
    })
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method.endsWith('operation.status')) {
        const old = !preparing || (params as { operationId?: string }).operationId === 'cu-old'
        return {
          status: 'found',
          operationId: old ? 'cu-old' : 'cu-new',
          kind: 'install',
          state: old ? 'failed' : 'running',
          phase: old ? 'complete' : 'installing',
        }
      }
      return {
        status: 'blocked',
        admission: { reason: 'runtime-unavailable' },
        blockers: [preparing ? 'driver-preparing' : 'driver-prepare-failed'],
      }
    })
    const controller = createComputerUseStatusController(
      { call: call as ComputerUseStatusClient['call'] },
      document,
      { wait: () => waiting },
    )
    await controller.refreshOperation()
    call.mockClear()
    preparing = true
    await controller.refresh()
    await vi.waitFor(() =>
      expect(document.getElementById('computer-use-operation-state')?.textContent).toBe('正在安装'),
    )
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.status', {})
    controller.dispose()
    finishWait()
  })

  it.each(['found', 'not-found'] as const)(
    'bounds rediscovery when %s conflicts with preparing status',
    async (status) => {
      const wait = vi.fn(async () => undefined)
      const call = vi.fn(async (method: string) =>
        method.endsWith('operation.status')
          ? { status, operationId: 'cu-old', kind: 'install', state: 'failed', phase: 'complete' }
          : {
              status: 'blocked',
              admission: { reason: 'runtime-unavailable' },
              blockers: ['driver-preparing'],
            },
      )
      const controller = createComputerUseStatusController(
        { call: call as ComputerUseStatusClient['call'] },
        document,
        { intervalMs: 17, maxAttempts: 3, wait },
      )
      await controller.refreshOperation()
      expect(wait).toHaveBeenCalledTimes(3)
      expect(wait).toHaveBeenCalledWith(17)
      expect(call).toHaveBeenCalledTimes(8)
      const operationCalls = call.mock.calls.filter(([method]) => method.endsWith('operation.status'))
      expect(operationCalls).toHaveLength(4)
      expect(document.getElementById('computer-use-operation-state')?.textContent).toBe('仍在执行')
      await Promise.resolve()
      expect(call).toHaveBeenCalledTimes(8)
    },
  )

  it('refreshes a replaced pane and delegates its new buttons only once', async () => {
    const call = vi.fn().mockRejectedValue(new Error('offline'))
    const controller = createComputerUseStatusController({ call })
    const old = document.getElementById('computer-use-state')
    const markup = document.body.innerHTML
    document.body.innerHTML = markup
    await vi.waitFor(() =>
      expect(document.getElementById('computer-use-state')?.textContent).toBe('无法读取'),
    )
    expect(old?.textContent).toBe('')
    call.mockClear()
    document.getElementById('computer-use-refresh')?.click()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    controller.dispose()
    document.getElementById('computer-use-refresh')?.click()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('ignores an old in-flight response after a pane is replaced', async () => {
    let finish: (value: unknown) => void = () => undefined
    const call = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockRejectedValue(new Error('offline'))
    const controller = createComputerUseStatusController({ call })
    const pending = controller.refresh()
    const markup = document.body.innerHTML
    document.body.innerHTML = markup
    await vi.waitFor(() =>
      expect(document.getElementById('computer-use-state')?.textContent).toBe('无法读取'),
    )
    finish({
      status: 'blocked',
      blockers: ['driver-not-prepared'],
      admission: { reason: 'runtime-unavailable' },
    })
    await pending
    expect(document.getElementById('computer-use-state')?.textContent).toBe('无法读取')
  })

  it.each([
    ['feature-disabled', '已关闭', true],
    ['platform-unsupported', '暂不支持', true],
    ['driver-not-prepared', '首次使用自动准备', false],
    ['driver-preparing', '准备中', true],
    ['driver-prepare-failed', '准备失败', false],
  ] as const)('renders %s with accurate preparation controls', async (reason, label, disabled) => {
    const call = vi.fn().mockImplementation(async (method) =>
      method.endsWith('operation.status')
        ? {
            status: 'found',
            operationId: 'cu-preparing',
            kind: 'install',
            state: 'running',
            phase: 'installing',
          }
        : {
            schemaVersion: 1,
            status: 'blocked',
            admission: { state: 'blocked', reason: 'runtime-unavailable' },
            runtime: { state: 'not-started', startAttempted: false },
            blockers: [reason],
          },
    )
    await createComputerUseStatusController({ call }).refresh()
    expect(document.getElementById('computer-use-state')?.textContent).toBe(label)
    expect((document.getElementById('computer-use-install') as HTMLButtonElement).disabled).toBe(disabled)
    expect((document.getElementById('computer-use-restart') as HTMLButtonElement).disabled).toBe(true)
    expect(call).toHaveBeenCalledTimes(reason === 'driver-preparing' ? 2 : 1)
  })

  it('monitors automatic preparation and refreshes failed status so retry is enabled', async () => {
    let finishWait!: () => void
    const wait = new Promise<void>((resolve) => {
      finishWait = resolve
    })
    let finished = false
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('operation.status'))
        return {
          status: 'found',
          operationId: 'cu-auto',
          kind: 'install',
          state: finished ? 'failed' : 'running',
          phase: finished ? 'complete' : 'installing',
        }
      return {
        status: 'blocked',
        admission: { reason: 'runtime-unavailable' },
        blockers: [finished ? 'driver-prepare-failed' : 'driver-preparing'],
      }
    })
    const controller = createComputerUseStatusController(
      { call: call as ComputerUseStatusClient['call'] },
      document,
      { wait: () => wait },
    )
    await controller.refresh()
    await vi.waitFor(() =>
      expect(document.getElementById('computer-use-operation-state')?.textContent).toBe('正在安装'),
    )
    expect((document.getElementById('computer-use-operation-cancel') as HTMLButtonElement).hidden).toBe(false)
    finished = true
    finishWait()
    await vi.waitFor(() =>
      expect(document.getElementById('computer-use-state')?.textContent).toBe('准备失败'),
    )
    expect((document.getElementById('computer-use-install') as HTMLButtonElement).disabled).toBe(false)
    expect(document.getElementById('computer-use-operation-state')?.textContent).toBe('操作失败')
  })

  it('does not probe permissions while the production gate is blocked', async () => {
    const call = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      status: 'blocked',
      admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
      runtime: { state: 'not-started', startAttempted: false },
      blockers: ['release-provenance-incomplete', 'platform-acceptance-incomplete'],
    })
    const controller = createComputerUseStatusController({ call: call as ComputerUseStatusClient['call'] })

    await controller.refresh()

    expect(call).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.status', {})
    expect(document.getElementById('computer-use-state')?.textContent).toBe('已阻止')
    expect(document.getElementById('computer-use-summary')?.textContent).toContain('准入保持关闭')
    expect(document.querySelectorAll('#computer-use-blockers li')).toHaveLength(2)
    expect(document.getElementById('computer-use-runtime')?.textContent).toContain('未尝试启动')
    expect(document.getElementById('computer-use-permission-state')?.textContent).toBe('不可用')
  })

  it('fails closed, clears stale details, and does not expose an RPC error', async () => {
    const secret = 'credential-should-not-render'
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'blocked',
        admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
        runtime: { state: 'not-started', startAttempted: false },
        blockers: ['compatibility-evidence-incomplete'],
      })
      .mockRejectedValueOnce(new Error(secret))
    const controller = createComputerUseStatusController({ call })
    await controller.refresh()

    await controller.refresh()

    expect(document.getElementById('computer-use-state')?.textContent).toBe('无法读取')
    expect(document.querySelectorAll('#computer-use-blockers li')).toHaveLength(0)
    expect(document.body.textContent).not.toContain(secret)
    expect(call).toHaveBeenNthCalledWith(2, '_agnes/v1/computerUse.status', {})
  })

  it('renders a verified Windows installation as usable', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'ready',
        admission: { state: 'ready', reason: 'windows-verified-driver' },
        runtime: { state: 'idle', startAttempted: true, activeSessions: 0 },
        blockers: [],
        driver: { platform: 'win32', version: '0.28.1', publisher: 'Cua AI, Inc.' },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'not-required',
        admission: { state: 'ready', reason: 'windows-verified-driver' },
        probe: { state: 'passed', reason: 'windows-no-os-grant-required' },
      })
    await createComputerUseStatusController({ call }).refresh()
    expect(document.getElementById('computer-use-state')?.textContent).toBe('可用')
    expect(document.getElementById('computer-use-summary')?.textContent).toContain('0.28.1')
    expect(document.getElementById('computer-use-runtime')?.textContent).toContain('之前已启动过')
    expect(document.getElementById('computer-use-permission-state')?.textContent).toBe('无需系统授权')
  })

  it('keeps a verified driver visible when only the permission probe fails', async () => {
    const secret = 'permission-probe-secret-should-not-render'
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'ready',
        admission: { state: 'ready', reason: 'macos-verified-driver' },
        runtime: { state: 'idle', startAttempted: false, activeSessions: 0 },
        blockers: [],
        driver: { platform: 'darwin', version: '0.28.1', publisher: 'Cua AI, Inc.' },
      })
      .mockRejectedValueOnce(new Error(secret))

    await createComputerUseStatusController({ call }).refresh()

    expect(document.getElementById('computer-use-state')?.textContent).toBe('可用')
    expect(document.getElementById('computer-use-summary')?.textContent).toContain('macOS 驱动 0.28.1')
    expect(document.getElementById('computer-use-permission-state')?.textContent).toBe('无法读取')
    expect(document.body.textContent).not.toContain(secret)
  })

  it('labels a verified Darwin runtime as macOS', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'ready',
        admission: { state: 'ready', reason: 'macos-verified-driver' },
        runtime: { state: 'idle', startAttempted: false, activeSessions: 0 },
        blockers: [],
        driver: {
          platform: 'darwin',
          version: '0.28.1',
          publisher: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        },
      })
      .mockResolvedValueOnce({
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
    await createComputerUseStatusController({ call }).refresh()
    expect(document.getElementById('computer-use-summary')?.textContent).toContain('macOS 驱动 0.28.1')
    expect(document.getElementById('computer-use-permission-state')?.textContent).toBe('需要授权')
    expect(document.getElementById('computer-use-permission-summary')?.textContent).toContain('屏幕录制')
    expect((document.getElementById('computer-use-permission-grant') as HTMLButtonElement).hidden).toBe(false)
  })

  it('uses the explicit permission-host RPC and renders only a verified grant', async () => {
    const call = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      status: 'granted',
      admission: { state: 'ready', reason: 'macos-verified-driver' },
      probe: {
        state: 'passed',
        reason: 'macos-tcc-permissions-granted',
        accessibility: true,
        screenRecording: true,
      },
    })
    const controller = createComputerUseStatusController({ call })

    await controller.grantPermissions()

    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.permissions.grant', {})
    expect(document.getElementById('computer-use-permission-state')?.textContent).toBe('已授权')
    expect((document.getElementById('computer-use-permission-grant') as HTMLButtonElement).hidden).toBe(true)
  })

  it('runs the read-only doctor route and renders a verified macOS result', async () => {
    const call = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      status: 'ready',
      admission: { state: 'ready', reason: 'macos-verified-driver' },
      checks: { state: 'passed', reason: 'macos-driver-health-and-identity-verified' },
    })
    const controller = createComputerUseStatusController({ call })

    await controller.doctor()

    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.doctor', {})
    expect(document.getElementById('computer-use-doctor-state')?.textContent).toBe('检查通过')
    expect(document.getElementById('computer-use-doctor-summary')?.textContent).toContain('macOS')
  })

  it('does not render doctor RPC error details', async () => {
    const secret = 'doctor-secret-should-not-render'
    const controller = createComputerUseStatusController({
      call: vi.fn().mockRejectedValue(new Error(secret)),
    })

    await controller.doctor()

    expect(document.getElementById('computer-use-doctor-state')?.textContent).toBe('检查失败')
    expect(document.body.textContent).not.toContain(secret)
  })

  it('renders structured failed and unreachable doctor results without raw error details', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'failed',
        admission: { state: 'ready', reason: 'windows-verified-driver' },
        checks: { state: 'failed', reason: 'windows-driver-health-or-identity-failed' },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'unreachable',
        admission: { state: 'ready', reason: 'macos-verified-driver' },
        checks: { state: 'unavailable', reason: 'live-driver-doctor-unavailable' },
      })
    const controller = createComputerUseStatusController({ call })

    await controller.doctor()
    expect(document.getElementById('computer-use-doctor-state')?.textContent).toBe('检查失败')
    expect(document.getElementById('computer-use-doctor-summary')?.textContent).toContain('签名身份')
    await controller.doctor()
    expect(document.getElementById('computer-use-doctor-state')?.textContent).toBe('无法连接')
    expect(document.getElementById('computer-use-doctor-summary')?.textContent).toContain('诊断入口')
  })

  it('does not let an older permission refresh overwrite a completed grant', async () => {
    let releaseStatus!: (value: unknown) => void
    const staleStatus = new Promise((resolve) => {
      releaseStatus = resolve
    })
    const call = vi.fn(async (method: string) => {
      if (method === '_agnes/v1/computerUse.status')
        return {
          schemaVersion: 1,
          status: 'ready',
          admission: { state: 'ready', reason: 'macos-verified-driver' },
          runtime: { state: 'idle', startAttempted: false, activeSessions: 0 },
          blockers: [],
          driver: { platform: 'darwin', version: '0.28.1', publisher: 'Cua AI, Inc.' },
        }
      if (method === '_agnes/v1/computerUse.permissions.status') return staleStatus
      return {
        schemaVersion: 1,
        status: 'granted',
        admission: { state: 'ready', reason: 'macos-verified-driver' },
        probe: {
          state: 'passed',
          reason: 'macos-tcc-permissions-granted',
          accessibility: true,
          screenRecording: true,
        },
      }
    })
    const controller = createComputerUseStatusController({ call: call as ComputerUseStatusClient['call'] })
    const refreshing = controller.refresh()
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.permissions.status', {}))

    await controller.grantPermissions()
    releaseStatus({
      schemaVersion: 1,
      status: 'required',
      admission: { state: 'ready', reason: 'macos-verified-driver' },
      probe: {
        state: 'passed',
        reason: 'macos-tcc-permissions-missing',
        accessibility: false,
        screenRecording: false,
      },
    })
    await refreshing

    expect(document.getElementById('computer-use-state')?.textContent).toBe('可用')
    expect(document.getElementById('computer-use-permission-state')?.textContent).toBe('已授权')
  })

  it('keeps refresh disabled until an overlapping permission grant settles', async () => {
    let releaseGrant!: (value: unknown) => void
    const pendingGrant = new Promise((resolve) => {
      releaseGrant = resolve
    })
    const call = vi.fn(async (method: string) => {
      if (method === '_agnes/v1/computerUse.permissions.grant') return pendingGrant
      return {
        schemaVersion: 1,
        status: 'blocked',
        admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
        runtime: { state: 'not-started', startAttempted: false },
        blockers: ['platform-acceptance-incomplete'],
      }
    })
    const controller = createComputerUseStatusController({ call: call as ComputerUseStatusClient['call'] })
    const granting = controller.grantPermissions()
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.permissions.grant', {}))

    await controller.refresh()

    expect((document.getElementById('computer-use-refresh') as HTMLButtonElement).disabled).toBe(true)
    releaseGrant({
      schemaVersion: 1,
      status: 'granted',
      admission: { state: 'ready', reason: 'macos-verified-driver' },
      probe: {
        state: 'passed',
        reason: 'macos-tcc-permissions-granted',
        accessibility: true,
        screenRecording: true,
      },
    })
    await granting

    expect((document.getElementById('computer-use-refresh') as HTMLButtonElement).disabled).toBe(false)
  })

  it('starts an update, renders bounded progress, and refreshes the verified status', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'ready',
        admission: { state: 'ready', reason: 'windows-verified-driver' },
        runtime: { state: 'idle', startAttempted: false, activeSessions: 0 },
        blockers: [],
        driver: { platform: 'win32', version: '0.28.1', publisher: 'Cua AI, Inc.' },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'not-required',
        admission: { state: 'ready', reason: 'windows-verified-driver' },
        probe: { state: 'passed', reason: 'windows-no-os-grant-required' },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'found',
        operationId: 'cu-update-1',
        kind: 'update',
        state: 'queued',
        phase: 'queued',
        startedAtMs: 1,
        updatedAtMs: 1,
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'found',
        operationId: 'cu-update-1',
        kind: 'update',
        state: 'succeeded',
        phase: 'complete',
        startedAtMs: 1,
        updatedAtMs: 2,
        outcome: 'already-current',
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'ready',
        admission: { state: 'ready', reason: 'windows-verified-driver' },
        runtime: { state: 'idle', startAttempted: false, activeSessions: 0 },
        blockers: [],
        driver: { platform: 'win32', version: '0.28.1', publisher: 'Cua AI, Inc.' },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'not-required',
        admission: { state: 'ready', reason: 'windows-verified-driver' },
        probe: { state: 'passed', reason: 'windows-no-os-grant-required' },
      })
    const controller = createComputerUseStatusController({ call }, document, {
      intervalMs: 0,
      wait: async () => undefined,
    })
    await controller.refresh()

    await controller.update()

    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.start', { kind: 'update' })
    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.status', {
      operationId: 'cu-update-1',
    })
    expect(document.getElementById('computer-use-operation-state')?.textContent).toBe('操作完成')
    expect(document.getElementById('computer-use-operation-summary')?.textContent).toContain('锁定版本')
    expect(document.body.textContent).not.toContain('operation-failed')
  })

  it('cancels an active operation without allowing an older poll to overwrite the result', async () => {
    let releasePoll!: (value: unknown) => void
    const pendingPoll = new Promise((resolve) => {
      releasePoll = resolve
    })
    const call = vi.fn(async (method: string) => {
      if (method === '_agnes/v1/computerUse.status')
        return {
          schemaVersion: 1,
          status: 'ready',
          admission: { state: 'ready', reason: 'windows-verified-driver' },
          runtime: { state: 'idle', startAttempted: false, activeSessions: 0 },
          blockers: [],
          driver: { platform: 'win32', version: '0.28.1', publisher: 'Cua AI, Inc.' },
        }
      if (method === '_agnes/v1/computerUse.permissions.status')
        return {
          schemaVersion: 1,
          status: 'not-required',
          admission: { state: 'ready', reason: 'windows-verified-driver' },
          probe: { state: 'passed', reason: 'windows-no-os-grant-required' },
        }
      if (method === '_agnes/v1/computerUse.operation.start')
        return {
          schemaVersion: 1,
          status: 'found',
          operationId: 'cu-install-1',
          kind: 'install',
          state: 'running',
          phase: 'installing',
          startedAtMs: 1,
          updatedAtMs: 1,
        }
      if (method === '_agnes/v1/computerUse.operation.cancel')
        return {
          schemaVersion: 1,
          status: 'found',
          operationId: 'cu-install-1',
          kind: 'install',
          state: 'cancelled',
          phase: 'complete',
          startedAtMs: 1,
          updatedAtMs: 3,
        }
      return pendingPoll
    })
    const controller = createComputerUseStatusController(
      { call: call as ComputerUseStatusClient['call'] },
      document,
      { intervalMs: 0, wait: async () => undefined },
    )
    await controller.refresh()
    const installing = controller.install()
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.status', {
        operationId: 'cu-install-1',
      }),
    )

    await controller.cancelOperation()
    releasePoll({
      schemaVersion: 1,
      status: 'found',
      operationId: 'cu-install-1',
      kind: 'install',
      state: 'running',
      phase: 'installing',
      startedAtMs: 1,
      updatedAtMs: 2,
    })
    await installing

    expect(document.getElementById('computer-use-operation-state')?.textContent).toBe('已取消')
    expect(document.getElementById('computer-use-operation-summary')?.textContent).not.toContain('credential')
  })

  it('does not start maintenance until the driver is admitted and hides RPC errors', async () => {
    const secret = 'maintenance-secret-should-not-render'
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: 'blocked',
        admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
        runtime: { state: 'not-started', startAttempted: false },
        blockers: ['platform-acceptance-incomplete'],
      })
      .mockRejectedValueOnce(new Error(secret))
    const controller = createComputerUseStatusController({ call })
    await controller.refresh()
    await controller.install()
    expect(call).toHaveBeenCalledOnce()

    await controller.refreshOperation()
    expect(document.getElementById('computer-use-operation-state')?.textContent).toBe('无法读取')
    expect((document.getElementById('computer-use-operation-refresh') as HTMLButtonElement).disabled).toBe(
      false,
    )
    expect(document.body.textContent).not.toContain(secret)
  })
})
