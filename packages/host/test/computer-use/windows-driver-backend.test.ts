import { describe, expect, it, vi } from 'vitest'
import {
  createWindowsComputerUseBackendProvider,
  windowsComputerUseDriverCommandForMode,
} from '../../src/computer-use/windows-driver-backend.js'
import type { ResolvedComputerUseProfile } from '../../src/profile/types.js'

const notesIdentity = {
  executablePath: 'C:\\Program Files\\Notes\\notes.exe',
  mappedImagePath: '\\Device\\HarddiskVolume1\\Program Files\\Notes\\notes.exe',
  imageBinding: 'mapped-image-file-handle-v1' as const,
  publisherSha256: 'a'.repeat(64),
  processStartTime: '100',
}
const terminalIdentity = {
  executablePath: 'C:\\Windows\\System32\\cmd.exe',
  mappedImagePath: '\\Device\\HarddiskVolume1\\Windows\\System32\\cmd.exe',
  imageBinding: 'mapped-image-file-handle-v1' as const,
  publisherSha256: 'b'.repeat(64),
  processStartTime: '200',
}
const paintIdentity = {
  executablePath:
    'C:\\Program Files\\WindowsApps\\Microsoft.Paint_1.0_x64__8wekyb3d8bbwe\\PaintApp\\mspaint.exe',
  mappedImagePath:
    '\\Device\\HarddiskVolume1\\Program Files\\WindowsApps\\Microsoft.Paint_1.0_x64__8wekyb3d8bbwe\\PaintApp\\mspaint.exe',
  imageBinding: 'mapped-image-file-handle-v1' as const,
  packageFamilyName: 'Microsoft.Paint_8wekyb3d8bbwe',
  processStartTime: '300',
}
const chromeIdentity = {
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  mappedImagePath: '\\Device\\HarddiskVolume1\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  imageBinding: 'mapped-image-file-handle-v1' as const,
  publisherSha256: 'c'.repeat(64),
  processStartTime: '400',
}
const profile: ResolvedComputerUseProfile = {
  enabled: true,
  appAccess: 'allowlist',
  appAllowlist: [
    { platform: 'win32', executablePath: notesIdentity.executablePath, publisherSha256: 'a'.repeat(64) },
    { platform: 'win32', executablePath: terminalIdentity.executablePath, publisherSha256: 'b'.repeat(64) },
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
  start = { notes: '100' },
  windows: { notesId: number; extraNotesIds?: number[] } = { notesId: 30 },
  captureOverrides: Record<string, unknown> = {},
  withImage: boolean | string = false,
  cursorBehavior: { failEnable: boolean; failEnd: boolean; endGate?: Promise<void> } = {
    failEnable: false,
    failEnd: false,
  },
  profileOverride: ResolvedComputerUseProfile = profile,
  screenSize: Readonly<{ width: number; height: number; scale_factor: number }> = {
    width: 1,
    height: 1,
    scale_factor: 1,
  },
) {
  let generation = 0
  let permissionMode: 'standard' | 'bounded' | 'unrestricted' = 'standard'
  const calls: Array<{ name: string; args: unknown }> = []
  let paintLaunched = false
  let browserLaunched = false
  const connection = {
    generation: 1,
    capabilityVersion: '1',
    catalog: new Map([
      ['start_session', {}],
      ['set_agent_cursor_enabled', {}],
      ['end_session', {}],
      ['launch_app', {}],
      ['get_desktop_state', {}],
      ['get_screen_size', {}],
    ]),
    pid: 1,
    transportId: 'test',
    async call(name: string, args: unknown) {
      calls.push({ name, args })
      if (name === 'end_session') await cursorBehavior.endGate
      if (name === 'set_agent_cursor_enabled' && cursorBehavior.failEnable)
        return { content: [], structuredContent: { ok: false }, isError: true }
      if (name === 'end_session' && cursorBehavior.failEnd)
        return { content: [], structuredContent: { ok: false }, isError: true }
      if (name === 'list_apps')
        return {
          content: [],
          structuredContent: {
            apps: [
              { name: 'Notes', pid: 10, active: true },
              { name: 'Command Prompt', pid: 20, active: false },
              { name: 'chrome.exe', pid: 40, active: false },
              {
                name: '画图',
                pid: 0,
                active: false,
                bundle_id: 'Microsoft.Paint_8wekyb3d8bbwe',
                launch_path: 'shell:appsFolder\\Microsoft.Paint_8wekyb3d8bbwe!App',
              },
              {
                name: 'Windows Terminal',
                pid: 0,
                active: false,
                bundle_id: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
                launch_path: 'shell:appsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App',
              },
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
                window_id: windows.notesId,
                title: 'Notes',
                bounds: { x: 1, y: 2, width: 800, height: 600 },
                z_index: 2,
              },
              {
                app_name: 'cmd.exe',
                pid: 20,
                window_id: 40,
                title: 'Command Prompt',
                bounds: { x: 0, y: 0, width: 400, height: 300 },
                z_index: 1,
              },
              ...(windows.extraNotesIds ?? []).map((windowId) => ({
                app_name: 'Notes',
                pid: 10,
                window_id: windowId,
                title: `Notes ${windowId}`,
                bounds: { x: 5, y: 6, width: 640, height: 480 },
                z_index: 3,
              })),
              ...(paintLaunched
                ? [
                    {
                      app_name: 'mspaint.exe',
                      pid: 30,
                      window_id: 50,
                      title: 'Untitled - Paint',
                      bounds: { x: 10, y: 20, width: 900, height: 700 },
                      z_index: 0,
                    },
                  ]
                : []),
              {
                app_name: 'chrome.exe',
                pid: 40,
                window_id: 60,
                title: '打开画板绘制图形 - Agnes Harness - Google Chrome',
                bounds: { x: 0, y: 0, width: 1200, height: 900 },
                z_index: 4,
              },
              ...(browserLaunched
                ? [
                    {
                      app_name: 'chrome.exe',
                      pid: 40,
                      window_id: 61,
                      title: 'New Tab - Google Chrome',
                      bounds: { x: 20, y: 20, width: 1200, height: 900 },
                      z_index: 0,
                    },
                  ]
                : []),
            ],
          },
          isError: false,
        }
      if (name === 'get_screen_size')
        return {
          content: [],
          structuredContent: screenSize,
          isError: false,
        }
      if (name === 'get_window_state' || name === 'get_desktop_state')
        return {
          content: withImage
            ? [
                {
                  type: 'image' as const,
                  mimeType: 'image/png',
                  data:
                    typeof withImage === 'string'
                      ? withImage
                      : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                },
              ]
            : [{ type: 'text' as const, text: 'tree' }],
          structuredContent: {
            ...(name === 'get_desktop_state'
              ? {
                  platform: 'windows',
                  display: 'primary',
                  screenshot_width: 1,
                  screenshot_height: 1,
                  screenshot_mime_type: 'image/png',
                }
              : {}),
            snapshot_id: 's12345678',
            elements: [{ index: 1, role: 'button', label: 'Save', element_token: 'token' }],
            safety: { reliable: true, secure_input: false, payment: false, two_factor: false },
            ...captureOverrides,
          },
          isError: false,
        }
      if (name === 'launch_app') {
        const launch = args as { path?: string }
        if (launch.path === chromeIdentity.executablePath) browserLaunched = true
        else paintLaunched = true
        return {
          content: [],
          structuredContent: { running: true, pid: 0, windows: [] },
          isError: false,
        }
      }
      return {
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { ok: true },
        isError: false,
      }
    },
    onClose() {
      return () => undefined
    },
    async close() {},
  }
  const runtime = {
    open: vi.fn(async (_session: unknown, _signal: AbortSignal) => {
      generation += 1
      connection.generation = generation
      return connection
    }),
    async captureObserve() {
      throw new Error('unused')
    },
    close: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async (_session, mode) => {
      permissionMode = mode
    }),
    permissionMode: () => permissionMode,
    dispose: vi.fn(async () => undefined),
  }
  const put = vi.fn(async () => ({ sha256: 'e'.repeat(64), size: 1, mime: 'image/png' as const }))
  const provider = createWindowsComputerUseBackendProvider({
    driver: {
      executablePath: 'C:\\driver\\cua-driver.exe',
      version: '0.28.1',
      publisher: 'Cua AI, Inc.',
      leafThumbprint: 'A'.repeat(40),
      publisherSha256: 'c'.repeat(64),
    },
    profile: profileOverride,
    profileHash: `sha256-${'d'.repeat(64)}`,
    artifacts: { put },
    dependencies: {
      runtime: runtime as never,
      processIdentity: (pid) => {
        if (pid === 10) return { ...notesIdentity, processStartTime: start.notes }
        if (pid === 20) return terminalIdentity
        if (pid === 30) return paintIdentity
        if (pid === 40) return chromeIdentity
        throw new Error('unknown pid')
      },
      boundedManifest: { path: 'C:\\agnes-data\\cua-capabilities.yaml', sha256: 'f'.repeat(64) },
    },
  })
  return { provider, runtime, calls, put, connection }
}

const session = Object.freeze({ key: 'session', lane: 'main' })
const signal = new AbortController().signal

describe('Windows Computer Use production backend', () => {
  it('binds every immutable driver permission mode to its real trusted-launch environment', () => {
    const base = { command: 'cua-driver.exe', args: ['mcp'], env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' } }
    expect(windowsComputerUseDriverCommandForMode(base, 'standard').env).toMatchObject({
      CUA_DRIVER_PERMISSION_MODE: 'standard',
    })
    expect(
      windowsComputerUseDriverCommandForMode(base, 'bounded', {
        path: 'C:\\agnes-data\\cua-capabilities.yaml',
        sha256: 'f'.repeat(64),
      }).env,
    ).toMatchObject({
      CUA_DRIVER_PERMISSION_MODE: 'bounded',
      CUA_DRIVER_CAPABILITY_MANIFEST_FILE: 'C:\\agnes-data\\cua-capabilities.yaml',
      CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: '1',
    })
    expect(windowsComputerUseDriverCommandForMode(base, 'unrestricted').env).toMatchObject({
      CUA_DRIVER_PERMISSION_MODE: 'unrestricted',
      CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: '1',
    })
    expect(() => windowsComputerUseDriverCommandForMode(base, 'bounded')).toThrow('reviewed')
  })
  it('filters discovery by stable signed identity and lets the hard-deny category override the allowlist', async () => {
    const { provider } = fixture()
    const backend = await provider.acquire(session, signal)
    await expect(backend.call({ action: 'list_apps' }, { session, signal })).resolves.toEqual({
      structuredContent: {
        apps: [{ app: 'Notes', pid: 10, frontmost: true, running: true, launchable: true }],
      },
      content: [],
      isError: false,
    })
    const windows = (await backend.call({ action: 'list_windows' }, { session, signal })) as {
      structuredContent: { windows: unknown[] }
    }
    expect(windows.structuredContent.windows).toHaveLength(1)
  })

  it('launches only an exact discovered app id and waits for an admitted live window', async () => {
    const launchProfile: ResolvedComputerUseProfile = {
      ...profile,
      appAllowlist: [
        {
          platform: 'win32',
          executablePath: paintIdentity.executablePath,
          packageFamilyName: paintIdentity.packageFamilyName,
        },
      ],
    }
    const { provider, calls } = fixture(undefined, undefined, undefined, undefined, undefined, launchProfile)
    const backend = await provider.acquire(session, signal)
    await expect(backend.call({ action: 'list_apps' }, { session, signal })).resolves.toEqual({
      structuredContent: {
        apps: [
          {
            app: '画图',
            app_id: 'Microsoft.Paint_8wekyb3d8bbwe',
            running: false,
            launchable: true,
          },
        ],
      },
      content: [],
      isError: false,
    })
    await expect(
      backend.call({ action: 'launch_app', app: 'Microsoft.Paint_8wekyb3d8bbwe' }, { session, signal }),
    ).resolves.toEqual({
      structuredContent: {
        ok: true,
        action: 'launch_app',
        effect: 'confirmed',
        target: { app: 'mspaint.exe', pid: 30, window_id: 50 },
      },
      content: [],
      isError: false,
    })
    expect(calls.find((call) => call.name === 'launch_app')).toEqual({
      name: 'launch_app',
      args: { aumid: 'Microsoft.Paint_8wekyb3d8bbwe!App' },
    })
  })

  it('does not expose a hard-denied installed terminal even when ordinary app access is all', async () => {
    const { provider, calls } = fixture(undefined, undefined, undefined, undefined, undefined, {
      ...profile,
      appAccess: 'all',
      appAllowlist: [],
    })
    const backend = await provider.acquire(session, signal)
    const result = (await backend.call({ action: 'list_apps' }, { session, signal })) as {
      structuredContent: { apps: Array<{ app: string }> }
    }
    expect(result.structuredContent.apps.some((app) => app.app === '画图')).toBe(true)
    expect(result.structuredContent.apps.some((app) => app.app === 'Windows Terminal')).toBe(false)
    await expect(
      backend.call({ action: 'launch_app', app: 'Windows Terminal' }, { session, signal }),
    ).resolves.toMatchObject({
      structuredContent: { ok: false, code: 'app_launch_blocked' },
      isError: true,
    })
    await expect(
      backend.call({ action: 'launch_app', app: 'Missing App' }, { session, signal }),
    ).resolves.toMatchObject({
      structuredContent: {
        ok: false,
        code: 'app_not_installed',
        message: expect.stringContaining('download and install'),
      },
      isError: true,
    })
    expect(calls.filter((call) => call.name === 'launch_app')).toHaveLength(0)
  })

  it('protects the Agnes browser window and launches a separate browser window', async () => {
    const { provider, calls } = fixture(undefined, undefined, undefined, undefined, undefined, {
      ...profile,
      appAccess: 'all',
      appAllowlist: [],
    })
    const backend = await provider.acquire(session, signal)
    const windows = (await backend.call({ action: 'list_windows' }, { session, signal })) as {
      structuredContent: { windows: Array<{ window_id: number }> }
    }
    expect(windows.structuredContent.windows.some((window) => window.window_id === 60)).toBe(false)
    await expect(
      backend.call({ action: 'capture', mode: 'som', pid: 40, window_id: 60 }, { session, signal }),
    ).rejects.toThrow('no longer present')

    const apps = (await backend.call({ action: 'list_apps' }, { session, signal })) as {
      structuredContent: { apps: Array<Record<string, unknown>> }
    }
    expect(apps.structuredContent.apps).toContainEqual(
      expect.objectContaining({ app: 'chrome.exe', running: true, launchable: true }),
    )
    await expect(
      backend.call({ action: 'launch_app', app: 'chrome.exe' }, { session, signal }),
    ).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        effect: 'confirmed',
        target: { app: 'chrome.exe', pid: 40, window_id: 61 },
      },
    })
    expect(calls.findLast((call) => call.name === 'launch_app')).toEqual({
      name: 'launch_app',
      args: { path: chromeIdentity.executablePath, additional_arguments: ['--new-window'] },
    })
  })

  it('binds focus_app without raising the window unless raise_window is explicitly true', async () => {
    const { provider, calls } = fixture()
    const backend = await provider.acquire(session, signal)
    const before = calls.filter((call) => call.name === 'bring_to_front').length
    await expect(
      backend.call({ action: 'focus_app', app: 'Notes' }, { session, signal }),
    ).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        effect: 'confirmed',
        target: { app: 'Notes', pid: 10, window_id: 30 },
      },
    })
    expect(calls.filter((call) => call.name === 'bring_to_front')).toHaveLength(before)
  })

  it('owns an opaque agent cursor session and closes its overlay before the transport', async () => {
    const { provider, runtime, calls } = fixture()
    const backend = await provider.acquire(session, signal)
    const started = calls.find((call) => call.name === 'start_session')
    if (!started) throw new Error('cursor session was not started')
    const cursorSession = (started.args as { session: string }).session
    expect(started).toMatchObject({
      args: {
        session: expect.stringMatching(/^agnes-[0-9a-f-]{36}$/u),
        capture_scope: 'window',
        cursor_theme: { theme_id: 'cua.default', reduced_motion: 'auto' },
      },
    })
    expect(started.args).not.toEqual(expect.objectContaining({ session: session.key }))
    expect(calls.find((call) => call.name === 'set_agent_cursor_enabled')).toMatchObject({
      args: { session: cursorSession, enabled: true },
    })

    await backend.call({ action: 'capture', mode: 'ax' }, { session, signal })
    expect(calls.at(-1)).toMatchObject({
      name: 'get_window_state',
      args: { session: cursorSession },
    })
    await backend.call({ action: 'focus_app', pid: 10, raise_window: true }, { session, signal })
    expect(calls.at(-1)).toMatchObject({
      name: 'bring_to_front',
      args: { session: cursorSession, pid: 10, window_id: 30 },
    })
    await provider.release(session)
    expect(calls.at(-1)).toMatchObject({
      name: 'end_session',
      args: { session: cursorSession },
    })
    expect(runtime.close).toHaveBeenCalledWith(session, 'session_end')
  })

  it('preserves fresh element targeting for text and keys instead of relying on ambient focus', async () => {
    const { provider, calls } = fixture()
    const backend = await provider.acquire(session, signal)
    const target = { app: 'Notes', pid: 10, windowId: 30, snapshotId: 's12345678' }
    await backend.call(
      {
        action: 'type',
        text: 'https://example.com',
        element: 1,
        element_token: 'address-bar-token',
        target,
        delivery_mode: 'foreground',
      },
      { session, signal },
    )
    expect(calls.at(-1)).toMatchObject({
      name: 'type_text',
      args: {
        pid: 10,
        window_id: 30,
        snapshot_id: 's12345678',
        element_index: 1,
        element_token: 'address-bar-token',
        text: 'https://example.com',
      },
    })
    await backend.call(
      {
        action: 'key',
        keys: 'return',
        element: 1,
        element_token: 'address-bar-token',
        target,
        delivery_mode: 'foreground',
      },
      { session, signal },
    )
    expect(calls.at(-1)).toMatchObject({
      name: 'press_key',
      args: { element_index: 1, element_token: 'address-bar-token', key: 'return' },
    })

    await backend.call({ action: 'type', text: 'plain text', target }, { session, signal })
    expect(calls.at(-1)).toMatchObject({
      name: 'type_text',
      args: { pid: 10, window_id: 30, text: 'plain text' },
    })
    expect(calls.at(-1)?.args).not.toHaveProperty('snapshot_id')

    await backend.call({ action: 'key', keys: 'return', target }, { session, signal })
    expect(calls.at(-1)).toMatchObject({
      name: 'press_key',
      args: { pid: 10, window_id: 30, key: 'return' },
    })
    expect(calls.at(-1)?.args).not.toHaveProperty('snapshot_id')
  })

  it('shares one first-open operation across concurrent calls in the same session lane', async () => {
    const { provider, runtime, calls } = fixture()
    const [first, second] = await Promise.all([
      provider.acquire(session, signal),
      provider.acquire(session, signal),
    ])
    expect(second).toBe(first)
    expect(runtime.open).toHaveBeenCalledTimes(1)
    expect(calls.filter((call) => call.name === 'start_session')).toHaveLength(1)
  })

  it('keeps the session transport alive when one tool-dispatch signal is aborted', async () => {
    const { provider, runtime } = fixture()
    const dispatch = new AbortController()
    const first = await provider.acquire(session, dispatch.signal)
    const lifetimeSignal = runtime.open.mock.calls[0]?.[1] as AbortSignal

    expect(lifetimeSignal).not.toBe(dispatch.signal)
    expect(lifetimeSignal.aborted).toBe(false)
    dispatch.abort()
    expect(lifetimeSignal.aborted).toBe(false)

    await expect(provider.acquire(session, new AbortController().signal)).resolves.toBe(first)
    expect(runtime.open).toHaveBeenCalledTimes(1)

    await provider.release(session)
    expect(lifetimeSignal.aborted).toBe(true)
  })

  it('does not claim reliable capture safety that the admitted driver contract lacks', async () => {
    const { provider } = fixture()
    const backend = await provider.acquire(session, signal)
    expect(backend).not.toHaveProperty('requiresReliableSafety')
  })

  it('keeps the tracked backend and cursor when permission mode is set to its current value', async () => {
    const { provider, runtime, calls } = fixture()
    const backend = await provider.acquire(session, signal)
    await provider.setPermissionMode(session, 'standard')
    expect(runtime.setPermissionMode).not.toHaveBeenCalled()
    expect(runtime.close).not.toHaveBeenCalled()
    expect(calls.filter((call) => call.name === 'end_session')).toHaveLength(0)
    expect(provider.status().activeSessions).toBe(1)
    await expect(provider.acquire(session, signal)).resolves.toBe(backend)
  })

  it('waits for release before a racing acquire publishes a replacement backend', async () => {
    let finishEnd: (() => void) | undefined
    const endGate = new Promise<void>((resolve) => {
      finishEnd = resolve
    })
    const { provider, runtime, calls } = fixture(undefined, undefined, {}, false, {
      failEnable: false,
      failEnd: false,
      endGate,
    })
    const first = await provider.acquire(session, signal)
    const releasing = provider.release(session)
    await vi.waitFor(() => expect(calls.filter((call) => call.name === 'end_session')).toHaveLength(1))

    let acquired = false
    const replacementTask = provider.acquire(session, signal).then((backend) => {
      acquired = true
      return backend
    })
    await Promise.resolve()
    expect(acquired).toBe(false)

    finishEnd?.()
    await releasing
    const replacement = await replacementTask
    expect(replacement).not.toBe(first)
    expect(runtime.open).toHaveBeenCalledTimes(2)
  })

  it('does not publish a backend when disposal wins a first-open race', async () => {
    const { provider, runtime, connection } = fixture()
    let releaseOpen: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    runtime.open.mockImplementationOnce(async () => {
      await gate
      return connection
    })
    const acquiring = provider.acquire(session, signal)
    const disposing = provider.dispose()
    releaseOpen()
    await expect(acquiring).rejects.toThrow('lifecycle changed while opening')
    await expect(disposing).resolves.toBeUndefined()
    expect(provider.status().activeSessions).toBe(0)
    await expect(provider.acquire(session, signal)).rejects.toThrow('provider is disposed')
  })

  it('does not publish an old-mode backend when a mode change wins the opening race', async () => {
    const { provider, runtime, connection } = fixture()
    let releaseOpen: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    runtime.open.mockImplementationOnce(async () => {
      await gate
      return connection
    })
    const acquiring = provider.acquire(session, signal)
    const changing = provider.setPermissionMode(session, 'bounded')
    releaseOpen()
    await expect(acquiring).rejects.toThrow('lifecycle changed while opening')
    await expect(changing).resolves.toBeUndefined()
    expect(provider.status().activeSessions).toBe(0)
    const current = await provider.acquire(session, signal)
    expect(current.runtimePolicy.mode).toBe('bounded')
  })

  it('fails closed and tears down transport when the locked cursor contract is absent', async () => {
    const { provider, runtime, connection } = fixture()
    connection.catalog.delete('end_session')
    await expect(provider.acquire(session, signal)).rejects.toThrow('required agent cursor tool end_session')
    expect(runtime.close).toHaveBeenCalledWith(session, 'session_end')
    expect(provider.status().activeSessions).toBe(0)
    connection.catalog.set('end_session', {})
    await expect(provider.acquire(session, signal)).resolves.toBeDefined()
    expect(runtime.open).toHaveBeenCalledTimes(2)
  })

  it('ends a partially started cursor session when enabling the overlay fails', async () => {
    const cursorBehavior = { failEnable: true, failEnd: false }
    const { provider, runtime, calls } = fixture({ notes: '100' }, { notesId: 30 }, {}, false, cursorBehavior)
    await expect(provider.acquire(session, signal)).rejects.toThrow('rejected the agent cursor overlay')
    expect(calls.map((call) => call.name)).toEqual([
      'start_session',
      'set_agent_cursor_enabled',
      'end_session',
    ])
    expect(runtime.close).toHaveBeenCalledWith(session, 'session_end')
  })

  it('still closes and evicts the transport when explicit cursor cleanup is rejected', async () => {
    const cursorBehavior = { failEnable: false, failEnd: false }
    const { provider, runtime } = fixture({ notes: '100' }, { notesId: 30 }, {}, false, cursorBehavior)
    await provider.acquire(session, signal)
    cursorBehavior.failEnd = true
    await expect(provider.release(session)).rejects.toThrow('cursor cleanup')
    expect(runtime.close).toHaveBeenCalledWith(session, 'session_end')
    expect(provider.status().activeSessions).toBe(0)
  })

  it('resolves the active allowed window and normalizes an AX capture without pixels', async () => {
    const { provider, calls } = fixture()
    const backend = await provider.acquire(session, signal)
    const result = (await backend.call({ action: 'capture', mode: 'ax' }, { session, signal })) as {
      structuredContent: Record<string, unknown>
    }
    expect(result.structuredContent).toMatchObject({
      mode: 'ax',
      width: 800,
      height: 600,
      target: { app: 'Notes', pid: 10, window_id: 30, snapshot_id: 's12345678' },
      safety: { reliable: true, secureInput: false, payment: false, twoFactor: false },
    })
    expect(calls.at(-1)).toMatchObject({
      name: 'get_window_state',
      args: { pid: 10, window_id: 30, include_accessibility_tree: true, include_screenshot: false },
    })
  })

  it('uses the reviewed driver desktop capture only when the profile explicitly enables it', async () => {
    const desktopProfile: ResolvedComputerUseProfile = {
      ...profile,
      capture: { ...profile.capture, allowFullDesktop: true },
    }
    const { provider, calls } = fixture(undefined, undefined, {}, true, undefined, desktopProfile)
    const backend = await provider.acquire(session, signal)
    const result = (await backend.call(
      { action: 'capture', mode: 'som', app: 'screen' },
      { session, signal },
    )) as { structuredContent: Record<string, unknown> }

    expect(calls.at(-1)).toMatchObject({ name: 'get_desktop_state' })
    expect(result.structuredContent).toMatchObject({
      mode: 'vision',
      width: 1,
      height: 1,
      app: 'screen',
      target: { app: 'screen' },
      elements: [],
    })

    const desktopCalls = calls.filter((call) => call.name === 'get_desktop_state').length
    await expect(
      backend.call({ action: 'capture', mode: 'vision', app: 'all' }, { session, signal }),
    ).rejects.toThrow('one exact target window')
    expect(calls.filter((call) => call.name === 'get_desktop_state')).toHaveLength(desktopCalls)
  })

  it('does not dispatch desktop capture while the profile gate is closed', async () => {
    const { provider, calls } = fixture(undefined, undefined, {}, true)
    const backend = await provider.acquire(session, signal)

    await expect(
      backend.call({ action: 'capture', mode: 'vision', app: 'desktop' }, { session, signal }),
    ).rejects.toThrow('full-desktop capture is disabled')
    expect(calls.some((call) => call.name === 'get_desktop_state')).toBe(false)
  })

  it('rejects accessibility-only desktop capture before dispatch because the driver is vision-only', async () => {
    const desktopProfile: ResolvedComputerUseProfile = {
      ...profile,
      capture: { ...profile.capture, allowFullDesktop: true },
    }
    const { provider, calls } = fixture(undefined, undefined, {}, true, undefined, desktopProfile)
    const backend = await provider.acquire(session, signal)

    await expect(
      backend.call({ action: 'capture', mode: 'ax', app: 'screen' }, { session, signal }),
    ).rejects.toThrow('full-desktop capture is vision-only')
    expect(calls.some((call) => call.name === 'get_desktop_state')).toBe(false)
  })

  it('preflights native desktop dimensions before requesting an oversized screenshot', async () => {
    const desktopProfile: ResolvedComputerUseProfile = {
      ...profile,
      capture: { ...profile.capture, allowFullDesktop: true },
    }
    const { provider, calls } = fixture(undefined, undefined, {}, true, undefined, desktopProfile, {
      width: 2560,
      height: 1440,
      scale_factor: 1.5,
    })
    const backend = await provider.acquire(session, signal)

    await expect(
      backend.call({ action: 'capture', mode: 'vision', app: 'screen' }, { session, signal }),
    ).rejects.toThrow('2560x1440, above the configured 1456px limit')
    expect(calls.at(-1)?.name).toBe('get_screen_size')
    expect(calls.some((call) => call.name === 'get_desktop_state')).toBe(false)
  })

  it('rejects a desktop image whose locked platform metadata is inconsistent', async () => {
    const desktopProfile: ResolvedComputerUseProfile = {
      ...profile,
      capture: { ...profile.capture, allowFullDesktop: true },
    }
    const { provider, put } = fixture(
      undefined,
      undefined,
      { platform: 'macos' },
      true,
      undefined,
      desktopProfile,
    )
    const backend = await provider.acquire(session, signal)

    await expect(
      backend.call({ action: 'capture', mode: 'vision', app: 'screen' }, { session, signal }),
    ).rejects.toThrow('wrong platform')
    expect(put).not.toHaveBeenCalled()
  })

  it('does not invent an unreliable safety result when the admitted driver omits the field', async () => {
    const { provider } = fixture({ notes: '100' }, { notesId: 30 }, { safety: undefined })
    const backend = await provider.acquire(session, signal)
    const result = (await backend.call({ action: 'capture', mode: 'ax' }, { session, signal })) as {
      structuredContent: Record<string, unknown>
    }
    expect(result.structuredContent).not.toHaveProperty('safety')
  })

  it('requires an exact application name and refuses an ambiguous window selection', async () => {
    const exact = fixture()
    const exactBackend = await exact.provider.acquire(session, signal)
    await expect(
      exactBackend.call({ action: 'capture', mode: 'ax', app: 'Note' }, { session, signal }),
    ).rejects.toThrow('one exact target window')

    const ambiguous = fixture({ notes: '100' }, { notesId: 30, extraNotesIds: [31] })
    const ambiguousBackend = await ambiguous.provider.acquire(session, signal)
    await expect(
      ambiguousBackend.call({ action: 'capture', mode: 'ax', app: 'Notes' }, { session, signal }),
    ).rejects.toThrow('one exact target window')
    await expect(
      ambiguousBackend.call(
        { action: 'capture', mode: 'ax', target: { pid: 10, window_id: 31 } },
        { session, signal },
      ),
    ).resolves.toMatchObject({ structuredContent: { target: { pid: 10, window_id: 31 } } })
  })

  it('rejects PID reuse between capture and input', async () => {
    const start = { notes: '100' }
    const { provider } = fixture(start)
    const backend = await provider.acquire(session, signal)
    await backend.call({ action: 'capture', mode: 'ax' }, { session, signal })
    start.notes = '101'
    await expect(
      backend.call(
        {
          action: 'click',
          target: { app: 'Notes', pid: 10, windowId: 30, snapshotId: 's12345678' },
          coordinate: [1, 2],
          delivery_mode: 'background',
        },
        { session, signal },
      ),
    ).rejects.toThrow('process identity changed')
  })

  it('rejects a stale window identity before dispatching input', async () => {
    const windows = { notesId: 30 }
    const { provider, calls } = fixture({ notes: '100' }, windows)
    const backend = await provider.acquire(session, signal)
    await backend.call({ action: 'capture', mode: 'ax' }, { session, signal })
    windows.notesId = 31
    await expect(
      backend.call(
        {
          action: 'click',
          target: { app: 'Notes', pid: 10, windowId: 30, snapshotId: 's12345678' },
          coordinate: [1, 2],
          delivery_mode: 'background',
        },
        { session, signal },
      ),
    ).rejects.toThrow('window identity changed')
    expect(calls.at(-1)?.name).toBe('list_windows')
  })

  it.each([
    [{ safety: { reliable: 'yes' } }, 'safety'],
    [
      {
        elements: [
          { index: 1, role: 'button' },
          { index: 1, role: 'button' },
        ],
      },
      'element index',
    ],
    [{ snapshot_id: 42 }, 'snapshot identity'],
  ])('validates structured capture metadata before persisting pixels %#', async (overrides, message) => {
    const { provider, put } = fixture({ notes: '100' }, { notesId: 30 }, overrides, true)
    const backend = await provider.acquire(session, signal)
    await expect(backend.call({ action: 'capture', mode: 'vision' }, { session, signal })).rejects.toThrow(
      message,
    )
    expect(put).not.toHaveBeenCalled()
  })

  it('accepts the locked driver zero-based element index', async () => {
    const { provider } = fixture(
      { notes: '100' },
      { notesId: 30 },
      { elements: [{ index: 0, role: 'button', label: 'Save', element_token: 'token-0' }] },
    )
    const backend = await provider.acquire(session, signal)
    await expect(backend.call({ action: 'capture', mode: 'ax' }, { session, signal })).resolves.toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          elements: [expect.objectContaining({ index: 0 })],
        }),
      }),
    )
  })

  it('rejects a capture whose longest edge exceeds the configured maximum before persistence', async () => {
    const oversized =
      'iVBORw0KGgoAAAANSUhEUgAABbEAAAABCAYAAADgtOPyAAAAHUlEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAAA4NQAFsUAAREWbvsAAAAASUVORK5CYII='
    const { provider, put } = fixture({ notes: '100' }, { notesId: 30 }, {}, oversized)
    const backend = await provider.acquire(session, signal)
    await expect(backend.call({ action: 'capture', mode: 'vision' }, { session, signal })).rejects.toThrow(
      'maximum image dimension',
    )
    expect(put).not.toHaveBeenCalled()
  })

  it('tears down and evicts the current backend when permission mode changes', async () => {
    const { provider, runtime } = fixture()
    const first = await provider.acquire(session, signal)
    await provider.setPermissionMode(session, 'bounded')
    const second = await provider.acquire(session, signal)
    expect(runtime.setPermissionMode).toHaveBeenCalledWith(session, 'bounded')
    expect(second).not.toBe(first)
    expect(second.runtimePolicy).toEqual({
      mode: 'bounded',
      authorization: 'reviewed-manifest',
      sessionKey: session.key,
      lane: session.lane,
      capabilityManifestDigest: 'f'.repeat(64),
    })
  })

  it('requires an explicit non-empty stable allowlist', () => {
    expect(() =>
      createWindowsComputerUseBackendProvider({
        driver: {
          executablePath: 'C:\\driver\\cua-driver.exe',
          version: '0.28.1',
          publisher: 'Cua AI, Inc.',
          leafThumbprint: 'A'.repeat(40),
          publisherSha256: 'c'.repeat(64),
        },
        profile: { ...profile, appAllowlist: [] },
        profileHash: 'profile',
        artifacts: { put: async () => ({ sha256: 'e'.repeat(64), size: 1, mime: 'image/png' }) },
        dependencies: { runtime: {} as never },
      }),
    ).toThrow('stable application identity')
  })
})
