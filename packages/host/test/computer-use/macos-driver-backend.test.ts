import { unlinkSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import {
  createMacOSComputerUseBackendProvider,
  grantMacOSComputerUsePermissions,
  probeMacOSComputerUsePermissions,
} from '../../src/computer-use/macos-driver-backend.js'
import type { ResolvedComputerUseProfile } from '../../src/profile/types.js'

const signature = 'a'.repeat(64)
const profile: ResolvedComputerUseProfile = {
  enabled: true,
  appAccess: 'allowlist',
  appAllowlist: [
    { platform: 'darwin', bundleId: 'com.apple.Notes', teamId: 'APPLE12345', signatureSha256: signature },
    {
      platform: 'darwin',
      bundleId: 'com.apple.Terminal',
      teamId: 'APPLE12345',
      signatureSha256: signature,
    },
  ],
  capture: {
    allowFullDesktop: false,
    maxImageDimension: 1456,
    maxBytesPerImage: 4 * 1024 * 1024,
    maxImagesPerResult: 1,
    maxImagesPerMutationResult: 2,
    maxImagesPerModelRequest: 4,
    maxCapturesPerHour: 120,
  },
  retention: {
    maxRecentPerSession: 20,
    ttlMs: 86_400_000,
    gcIntervalMs: 3_600_000,
    maxExtendedTtlMs: 604_800_000,
    globalMaxBytes: 1024 * 1024 * 1024,
  },
}

function fixture(
  options: Readonly<{
    profile?: ResolvedComputerUseProfile
    includeBrowserWindows?: boolean
    extraWindows?: readonly Record<string, unknown>[]
    screenSize?: Readonly<{ width: number; height: number; scale_factor: number }>
    processIdentity?: (pid: number) => Record<string, unknown>
  }> = {},
) {
  const calls: Array<{ name: string; args: unknown }> = []
  const connection = {
    generation: 1,
    capabilityVersion: '1',
    catalog: new Map([
      ['start_session', {}],
      ['set_agent_cursor_enabled', {}],
      ['end_session', {}],
      ['get_desktop_state', {}],
      ['get_screen_size', {}],
    ]),
    pid: 1,
    transportId: 'mac-test',
    async call(name: string, args: unknown) {
      calls.push({ name, args })
      if (name === 'list_apps')
        return {
          content: [],
          structuredContent: {
            apps: [
              { name: 'Notes', pid: 10, active: true },
              { name: 'Terminal', pid: 20, active: false },
            ],
          },
          isError: false,
        }
      if (name === 'list_windows')
        return {
          content: [],
          structuredContent: {
            windows: [
              {
                app_name: 'Notes',
                pid: 10,
                window_id: 30,
                title: 'Notes',
                bounds: { x: 0, y: 0, width: 800, height: 600 },
                active: true,
              },
              {
                app_name: 'Terminal',
                pid: 20,
                window_id: 40,
                title: 'Terminal',
                bounds: { x: 0, y: 0, width: 800, height: 600 },
              },
              ...(options.includeBrowserWindows
                ? [
                    {
                      app_name: 'com.google.Chrome',
                      pid: 40,
                      window_id: 50,
                      title: '打开画板绘制图形 - Agnes Harness - Google Chrome',
                      bounds: { x: 0, y: 0, width: 1200, height: 900 },
                    },
                    {
                      app_name: 'com.google.Chrome',
                      pid: 40,
                      window_id: 51,
                      title: 'New Tab - Google Chrome',
                      bounds: { x: 20, y: 20, width: 1200, height: 900 },
                    },
                  ]
                : []),
              ...(options.extraWindows ?? []),
            ],
          },
          isError: false,
        }
      if (name === 'get_desktop_state')
        return {
          content: [
            {
              type: 'image' as const,
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            },
          ],
          structuredContent: {
            platform: 'macos',
            display: 'primary',
            screenshot_width: 1,
            screenshot_height: 1,
            screenshot_mime_type: 'image/png',
          },
          isError: false,
        }
      if (name === 'get_screen_size')
        return {
          content: [],
          structuredContent: options.screenSize ?? { width: 1, height: 1, scale_factor: 1 },
          isError: false,
        }
      return { content: [], structuredContent: { ok: true }, isError: false }
    },
    onClose() {
      return () => undefined
    },
    async close() {},
  }
  const runtime = {
    open: vi.fn(async () => connection),
    captureObserve: vi.fn(),
    close: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    permissionMode: () => 'standard' as const,
    dispose: vi.fn(async () => undefined),
  }
  const processStarts = { notes: 'darwin:1.000001:2.000002' }
  const provider = createMacOSComputerUseBackendProvider({
    driver: {
      executablePath: '/private/driver/cua-driver',
      version: '0.28.1',
      bundleId: 'com.trycua.driver',
      teamId: 'YCK386LBJ7',
      authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
      appPath: '/private/driver/CuaDriver.app',
    },
    profile: options.profile ?? profile,
    profileHash: `sha256-${'b'.repeat(64)}`,
    artifacts: { put: async () => ({ sha256: 'c'.repeat(64), size: 1, mime: 'image/png' }) },
    dependencies: {
      runtime: runtime as never,
      processIdentity: (options.processIdentity ??
        ((pid: number) => ({
          platform: 'darwin',
          bundleId: pid === 10 ? 'com.apple.Notes' : pid === 40 ? 'com.google.Chrome' : 'com.apple.Terminal',
          teamId: 'APPLE12345',
          signatureSha256: signature,
          processStartTime: pid === 10 ? processStarts.notes : 'darwin:1.000001:3.000003',
        }))) as never,
    },
  })
  return { provider, calls, processStarts }
}

const session = { key: 's', lane: 'main' }
const signal = new AbortController().signal

it('filters macOS discovery by live signed identity and hard-denies Terminal', async () => {
  const { provider } = fixture()
  const backend = await provider.acquire(session, signal)
  const apps = await backend.call({ action: 'list_apps' }, { session, signal })
  expect(apps).toMatchObject({ structuredContent: { apps: [{ app: 'Notes', pid: 10 }] } })
  const windows = (await backend.call({ action: 'list_windows' }, { session, signal })) as {
    structuredContent: { windows: unknown[] }
  }
  expect(windows.structuredContent.windows).toHaveLength(1)
})

it('lists a strict-validated Apple platform app without a Team ID in all-apps mode', async () => {
  const { provider } = fixture({
    profile: { ...profile, appAccess: 'all', appAllowlist: [] },
    processIdentity: (pid) => ({
      platform: 'darwin',
      bundleId: pid === 10 ? 'com.apple.finder' : 'com.apple.Terminal',
      signatureSha256: signature,
      processStartTime: pid === 10 ? 'darwin:1.000001:2.000002' : 'darwin:1.000001:3.000003',
    }),
  })
  const backend = await provider.acquire(session, signal)
  await expect(backend.call({ action: 'list_apps' }, { session, signal })).resolves.toEqual({
    structuredContent: {
      apps: [{ app: 'Notes', pid: 10, frontmost: true, running: true, launchable: true }],
    },
    content: [],
    isError: false,
  })
})

it('protects the Agnes browser window when macOS discovery returns a bundle id as the app name', async () => {
  const browserProfile: ResolvedComputerUseProfile = {
    ...profile,
    appAllowlist: [
      ...profile.appAllowlist,
      { platform: 'darwin', bundleId: 'com.google.Chrome', teamId: 'APPLE12345', signatureSha256: signature },
    ],
  }
  const { provider } = fixture({ profile: browserProfile, includeBrowserWindows: true })
  const backend = await provider.acquire(session, signal)
  const windows = (await backend.call({ action: 'list_windows' }, { session, signal })) as {
    structuredContent: { windows: Array<{ window_id: number }> }
  }

  expect(windows.structuredContent.windows.map((window) => window.window_id)).toEqual([30, 51])
})

it('skips the zero-size offscreen windows macOS always reports instead of failing the listing', async () => {
  // Real 0.28.1 output: the driver's own helper, WebThumbnailExtension and Universal Control.
  const hidden = (app: string, pid: number) => ({
    app_name: app,
    pid,
    window_id: pid + 1000,
    title: '',
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    is_on_screen: false,
  })
  const { provider } = fixture({
    extraWindows: [hidden('Cua Driver', 70), hidden('WebThumbnailExte', 71), hidden('Universal Control', 72)],
  })
  const backend = await provider.acquire(session, signal)
  const windows = (await backend.call({ action: 'list_windows' }, { session, signal })) as {
    structuredContent: { windows: Array<{ window_id: number }> }
  }
  expect(windows.structuredContent.windows.map((window) => window.window_id)).toEqual([30])
})

it('still rejects a window row whose bounds are malformed', async () => {
  const { provider } = fixture({
    extraWindows: [{ app_name: 'Notes', pid: 10, window_id: 31, title: '', bounds: { x: 0, y: 0 } }],
  })
  const backend = await provider.acquire(session, signal)
  await expect(backend.call({ action: 'list_windows' }, { session, signal })).rejects.toThrow(
    'Computer Use window bounds are invalid',
  )
})

it('shares the reviewed full-desktop capture path with Windows behind the explicit profile gate', async () => {
  const desktopProfile: ResolvedComputerUseProfile = {
    ...profile,
    capture: { ...profile.capture, allowFullDesktop: true },
  }
  const { provider, calls } = fixture({ profile: desktopProfile })
  const backend = await provider.acquire(session, signal)
  const result = (await backend.call(
    { action: 'capture', mode: 'som', app: 'desktop' },
    { session, signal },
  )) as { structuredContent: Record<string, unknown> }

  expect(calls.at(-1)).toMatchObject({ name: 'get_desktop_state' })
  expect(result.structuredContent).toMatchObject({
    mode: 'vision',
    app: 'desktop',
    target: { app: 'desktop' },
    elements: [],
  })
})

it('uses Retina backing scale when preflighting a macOS desktop capture', async () => {
  const desktopProfile: ResolvedComputerUseProfile = {
    ...profile,
    capture: { ...profile.capture, allowFullDesktop: true },
  }
  const { provider, calls } = fixture({
    profile: desktopProfile,
    screenSize: { width: 900, height: 700, scale_factor: 2 },
  })
  const backend = await provider.acquire(session, signal)

  await expect(
    backend.call({ action: 'capture', mode: 'vision', app: 'screen' }, { session, signal }),
  ).rejects.toThrow('1800x1400, above the configured 1456px limit')
  expect(calls.at(-1)?.name).toBe('get_screen_size')
  expect(calls.some((call) => call.name === 'get_desktop_state')).toBe(false)
})

it('rejects a recycled macOS process before dispatching input', async () => {
  const { provider, processStarts, calls } = fixture()
  const backend = await provider.acquire(session, signal)
  await backend.call({ action: 'list_windows' }, { session, signal })
  processStarts.notes = 'darwin:1.000001:9.000009'
  await expect(
    backend.call(
      { action: 'click', target: { pid: 10, windowId: 30 }, coordinate: [4, 5] },
      { session, signal },
    ),
  ).rejects.toThrow('process identity changed')
  expect(calls.at(-1)?.name).toBe('list_windows')
})

it('reads TCC state only from the signed app daemon and never prompts', async () => {
  const call = vi.fn(async (_name: string, _args: unknown) => ({
    content: [],
    structuredContent: {
      accessibility: true,
      screen_recording: false,
      screen_recording_capturable: null,
      direct_capture_status: 'not_checked',
      direct_capture_error: null,
      source: { attribution: 'driver-daemon', bundle_id: 'com.trycua.driver' },
    },
    isError: false,
  }))
  const connection = {
    catalog: new Map([['check_permissions', {}]]),
    call,
  }
  const runtime = {
    open: vi.fn(async () => connection),
    close: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  }
  await expect(
    probeMacOSComputerUsePermissions({
      driver: {
        executablePath: '/private/driver/cua-driver',
        version: '0.28.1',
        bundleId: 'com.trycua.driver',
        teamId: 'YCK386LBJ7',
        authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        appPath: '/private/driver/CuaDriver.app',
      },
      runtime: runtime as never,
    }),
  ).resolves.toEqual({ accessibility: true, screenRecording: false })
  expect(call).toHaveBeenCalledWith(
    'check_permissions',
    { prompt: false },
    expect.objectContaining({ timeoutMs: 10_000 }),
  )
  expect(runtime.close).toHaveBeenCalledTimes(1)
  expect(runtime.dispose).toHaveBeenCalledTimes(1)
})

it('rejects a TCC result attributed to the caller instead of CuaDriver.app', async () => {
  const runtime = {
    open: vi.fn(async () => ({
      catalog: new Map([['check_permissions', {}]]),
      async call() {
        return {
          content: [],
          structuredContent: {
            accessibility: true,
            screen_recording: true,
            screen_recording_capturable: null,
            direct_capture_status: 'not_checked',
            source: { attribution: 'caller', bundle_id: null },
          },
          isError: false,
        }
      },
    })),
    close: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  }
  await expect(
    probeMacOSComputerUsePermissions({
      driver: {
        executablePath: '/private/driver/cua-driver',
        version: '0.28.1',
        bundleId: 'com.trycua.driver',
        teamId: 'YCK386LBJ7',
        authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        appPath: '/private/driver/CuaDriver.app',
      },
      runtime: runtime as never,
    }),
  ).rejects.toThrow('untrusted attribution')
})

it('uses the private LaunchServices permission host for an explicit full grant', async () => {
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    const resultPath = args[args.indexOf('--result-file') + 1]
    if (!resultPath) throw new Error('missing result path')
    writeFileSync(
      resultPath,
      JSON.stringify({
        content: [],
        structuredContent: {
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          direct_capture_status: 'ready',
          source: { attribution: 'driver-daemon', bundle_id: 'com.trycua.driver' },
        },
      }),
    )
  })
  await grantMacOSComputerUsePermissions({
    driver: {
      executablePath: '/private/driver/cua-driver',
      version: '0.28.1',
      bundleId: 'com.trycua.driver',
      teamId: 'YCK386LBJ7',
      authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
      appPath: '/private/driver/CuaDriver.app',
    },
    run,
  })
  expect(run).toHaveBeenCalledWith(
    '/usr/bin/open',
    expect.arrayContaining([
      '-W',
      '/private/driver/CuaDriver.app',
      '__permissions-host-request',
      '--probe-direct-capture',
    ]),
    undefined,
  )
})

it('rejects an explicit permission-host error even when its structured fields claim success', async () => {
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    const resultPath = args[args.indexOf('--result-file') + 1]
    if (!resultPath) throw new Error('missing result path')
    writeFileSync(
      resultPath,
      JSON.stringify({
        isError: true,
        structuredContent: {
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          direct_capture_status: 'ready',
          source: { attribution: 'driver-daemon', bundle_id: 'com.trycua.driver' },
        },
      }),
    )
  })
  await expect(
    grantMacOSComputerUsePermissions({
      driver: {
        executablePath: '/private/driver/cua-driver',
        version: '0.28.1',
        bundleId: 'com.trycua.driver',
        teamId: 'YCK386LBJ7',
        authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        appPath: '/private/driver/CuaDriver.app',
      },
      run,
    }),
  ).rejects.toThrow('not fully granted')
})

it.each(['true', 1, null, {}])('rejects a malformed permission-host isError value: %j', async (isError) => {
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    const resultPath = args[args.indexOf('--result-file') + 1]
    if (!resultPath) throw new Error('missing result path')
    writeFileSync(
      resultPath,
      JSON.stringify({
        isError,
        structuredContent: {
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          direct_capture_status: 'ready',
          source: { attribution: 'driver-daemon', bundle_id: 'com.trycua.driver' },
        },
      }),
    )
  })
  await expect(
    grantMacOSComputerUsePermissions({
      driver: {
        executablePath: '/private/driver/cua-driver',
        version: '0.28.1',
        bundleId: 'com.trycua.driver',
        teamId: 'YCK386LBJ7',
        authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        appPath: '/private/driver/CuaDriver.app',
      },
      run,
    }),
  ).rejects.toThrow('not fully granted')
})

it('rejects a permission grant result that is not attributed to the verified driver bundle', async () => {
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    const resultPath = args[args.indexOf('--result-file') + 1]
    if (!resultPath) throw new Error('missing result path')
    writeFileSync(
      resultPath,
      JSON.stringify({
        isError: false,
        structuredContent: {
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          direct_capture_status: 'ready',
          source: { attribution: 'caller', bundle_id: 'com.trycua.driver' },
        },
      }),
    )
  })
  await expect(
    grantMacOSComputerUsePermissions({
      driver: {
        executablePath: '/private/driver/cua-driver',
        version: '0.28.1',
        bundleId: 'com.trycua.driver',
        teamId: 'YCK386LBJ7',
        authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        appPath: '/private/driver/CuaDriver.app',
      },
      run,
    }),
  ).rejects.toThrow('not fully granted')
})

it('rejects a permission result path replaced after the private file was created', async () => {
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    const resultPath = args[args.indexOf('--result-file') + 1]
    if (!resultPath) throw new Error('missing result path')
    unlinkSync(resultPath)
    writeFileSync(
      resultPath,
      JSON.stringify({
        isError: false,
        structuredContent: {
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          direct_capture_status: 'ready',
          source: { attribution: 'driver-daemon', bundle_id: 'com.trycua.driver' },
        },
      }),
      { mode: 0o600 },
    )
  })

  await expect(
    grantMacOSComputerUsePermissions({
      driver: {
        executablePath: '/private/driver/cua-driver',
        version: '0.28.1',
        bundleId: 'com.trycua.driver',
        teamId: 'YCK386LBJ7',
        authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
        appPath: '/private/driver/CuaDriver.app',
      },
      run,
    }),
  ).rejects.toThrow('result file is unsafe')
})
