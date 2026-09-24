import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createMacOSComputerUseSessionRuntime } from '../../src/computer-use/macos-driver-backend.js'

const driver = {
  executablePath: '/private/driver/cua-driver',
  appPath: '/private/driver/CuaDriver.app',
  version: '0.28.1',
  bundleId: 'com.trycua.driver',
  teamId: 'YCK386LBJ7',
  authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
}
const session = { key: 'session', lane: 'main' }

function fixture() {
  const listeners: Array<() => void> = []
  const connection = {
    generation: 1,
    capabilityVersion: '1',
    catalog: new Map(),
    pid: 1,
    transportId: 'mac-runtime',
    call: vi.fn(),
    onClose(listener: () => void) {
      listeners.push(listener)
      return () => undefined
    },
    close: vi.fn(async () => undefined),
    closeForReset: vi.fn(async () => {
      for (const listener of listeners) listener()
    }),
    cancelFromSession: vi.fn(async () => undefined),
  }
  const launch = vi.fn(async (_command: string, _args: readonly string[], _signal?: AbortSignal) => undefined)
  const connect = vi.fn(
    async (_command: unknown, _generation: number, _sessionToken: string, _signal: AbortSignal) => connection,
  )
  const ready = vi.fn(async () => undefined)
  return { connection, launch, ready, connect }
}

it.each([
  ['standard', ['--permission-mode', 'standard']],
  [
    'bounded',
    [
      '--permission-mode',
      'bounded',
      '--capability-manifest',
      resolve('capability.yaml'),
      '--approve-capability-manifest',
    ],
  ],
  ['unrestricted', ['--permission-mode', 'unrestricted', '--dangerously-bypass-approvals']],
] as const)('launches the signed app through LaunchServices in %s mode', async (mode, flags) => {
  const { launch, ready, connect } = fixture()
  const runtime = createMacOSComputerUseSessionRuntime(driver, {
    boundedManifest: { path: resolve('capability.yaml'), sha256: 'a'.repeat(64) },
    launch,
    ready,
    connect: connect as never,
  })
  if (mode !== 'standard') await runtime.setPermissionMode(session, mode)
  await runtime.open(session, new AbortController().signal)
  const open = launch.mock.calls[0]
  expect(open?.[0]).toBe('/usr/bin/open')
  expect(open?.[1]).toEqual(
    expect.arrayContaining(['-n', '-g', '-a', driver.appPath, '--args', 'serve', '--socket', ...flags]),
  )
  // The driver's own first-launch gate raises the TCC dialogs on every fresh daemon.
  expect(open?.[1]).toContain('--no-permissions-gate')
  const command = connect.mock.calls[0]?.[0] as { args: string[] }
  expect(ready).toHaveBeenCalledWith(
    driver.executablePath,
    expect.stringMatching(/agnes-cua-[a-f0-9]{16}-[^/\\]+[/\\]driver\.sock$/u),
    expect.any(AbortSignal),
  )
  expect(command.args.slice(0, 2)).toEqual(['mcp', '--socket'])
  await runtime.close(session, 'session_end')
  expect(launch).toHaveBeenCalledWith(driver.executablePath, [
    'stop',
    '--socket',
    expect.stringMatching(/agnes-cua-[a-f0-9]{16}-[^/\\]+[/\\]driver\.sock$/u),
  ])
})

it('stops a launched daemon if the MCP connection fails', async () => {
  const launch = vi.fn(async (_command: string, _args: readonly string[], _signal?: AbortSignal) => undefined)
  const runtime = createMacOSComputerUseSessionRuntime(driver, {
    launch,
    ready: async () => undefined,
    connect: vi.fn(async () => {
      throw new Error('connect failed')
    }),
  })
  await expect(runtime.open(session, new AbortController().signal)).rejects.toThrow('connect failed')
  expect(launch).toHaveBeenCalledTimes(2)
  expect(launch.mock.calls[1]?.[0]).toBe(driver.executablePath)
  expect(launch.mock.calls[1]?.[1]?.[0]).toBe('stop')
})

it('stops the signed app when its exact socket never becomes ready', async () => {
  const launch = vi.fn(async (_command: string, _args: readonly string[], _signal?: AbortSignal) => undefined)
  const runtime = createMacOSComputerUseSessionRuntime(driver, {
    launch,
    ready: async () => {
      throw new Error('socket timeout')
    },
    connect: vi.fn() as never,
  })
  await expect(runtime.open(session, new AbortController().signal)).rejects.toThrow('socket timeout')
  expect(launch).toHaveBeenCalledTimes(2)
  expect(launch.mock.calls[1]?.[1]?.[0]).toBe('stop')
})

it('rejects an unreviewed bounded manifest before launching an app', () => {
  expect(() =>
    createMacOSComputerUseSessionRuntime(driver, {
      boundedManifest: { path: 'relative.yaml', sha256: 'a'.repeat(64) },
    }),
  ).toThrow('identity')
})

function permissionResult(accessibility: boolean, screenRecording: boolean) {
  return {
    isError: false,
    structuredContent: {
      accessibility,
      screen_recording: screenRecording,
      screen_recording_capturable: null,
      direct_capture_status: 'not_checked',
      source: { attribution: 'driver-daemon', bundle_id: driver.bundleId },
    },
  }
}

it.each([
  [false, true, 'Accessibility'],
  [true, false, 'Screen Recording'],
  [false, false, 'Accessibility and Screen Recording'],
] as const)('refuses a work daemon without TCC grants (ax=%s, screen=%s)', async (ax, screen, missing) => {
  const { connection, launch, ready, connect } = fixture()
  connection.catalog.set('check_permissions', {})
  connection.call.mockResolvedValue(permissionResult(ax, screen))
  const runtime = createMacOSComputerUseSessionRuntime(driver, {
    launch,
    ready,
    connect: connect as never,
    requirePermissions: true,
  })
  await expect(runtime.open(session, new AbortController().signal)).rejects.toThrow(
    `Computer Use is not authorized on this Mac: CuaDriver lacks ${missing} permission`,
  )
  expect(connection.call).toHaveBeenCalledWith('check_permissions', { prompt: false }, expect.anything())
  expect(connection.close).toHaveBeenCalled()
  expect(launch.mock.calls.at(-1)?.[1]?.[0]).toBe('stop')
})

it('opens a work daemon once both TCC grants are present', async () => {
  const { connection, launch, ready, connect } = fixture()
  connection.catalog.set('check_permissions', {})
  connection.call.mockResolvedValue(permissionResult(true, true))
  const runtime = createMacOSComputerUseSessionRuntime(driver, {
    launch,
    ready,
    connect: connect as never,
    requirePermissions: true,
  })
  await runtime.open(session, new AbortController().signal)
  expect(connection.close).not.toHaveBeenCalled()
  expect(launch).toHaveBeenCalledTimes(1)
  await runtime.close(session, 'session_end')
})
