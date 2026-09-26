import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsureLocalBackendOptions, LocalBackend } from './backend.js'
import { parseWebCommand, runWebCommand, type WebCommandIO } from './web-command.js'

// M5: proves the Surface mount poller's `close()` is on runWebCommand's shutdown ladder, not just
// constructed and forgotten -- a leaked `setInterval` would otherwise keep polling (and, in a real
// process, keep the event loop alive if it were ever not `.unref()`'d) after the command returns.
// `fetchSurfaceMountProxy` is replaced with an in-memory fake so this is a pure shutdown-ordering
// assertion, not a second real-poller test (surface-mounts.test.ts already owns that). `vi.mock` is
// hoisted above the static import above regardless of source order, so `runWebCommand` resolves this
// mocked module.
let mountCloseCalls = 0
vi.mock('./surface-mounts.js', async (importActual) => {
  const actual = await importActual<typeof import('./surface-mounts.js')>()
  return {
    ...actual,
    fetchSurfaceMountProxy: vi.fn(async () => ({
      proxy: () => false,
      close: async () => {
        mountCloseCalls++
      },
    })),
  }
})

// A local daemon listens on a named pipe on Windows and a Unix socket elsewhere; the SDK refuses to
// open a non-pipe path on Windows, so an unreachable backend has to use the platform's own form.
const unreachableSocket =
  process.platform === 'win32' ? '\\\\.\\pipe\\agnes-does-not-exist' : '/tmp/agnes-does-not-exist.sock'

const resources = {
  mode: 'package' as const,
  root: '/tmp/local-runtime',
  daemonEntry: '/tmp/local-runtime/daemon.mjs',
  workerEntry: '/tmp/local-runtime/worker.mjs',
  webRoot: '/tmp/local-runtime/web',
}

describe('Web command launch contract', () => {
  beforeEach(() => {
    mountCloseCalls = 0
  })

  it('uses the exact environment origin when no port override is supplied', () => {
    expect(parseWebCommand([], { AGNES_WEB_ORIGIN: 'http://127.0.0.1:4180' }).port).toBe(4180)
    expect(parseWebCommand(['--port', '4181'], { AGNES_WEB_ORIGIN: 'http://127.0.0.1:4180' }).port).toBe(4181)
  })

  // Only `--home` is an explicit home. A home variable stays in the environment handed to the
  // backend, whose agnesHome(env) applies AGH_HOME > AGNES_HOME and the deprecation notice; lifting
  // one out here would let the legacy name beat AGH_HOME and skip the notice.
  it('takes an explicit home only from --home, never from a home variable', () => {
    expect(Object.hasOwn(parseWebCommand([], { AGNES_HOME: '/tmp/legacy-home' }), 'home')).toBe(false)
    expect(Object.hasOwn(parseWebCommand([], { AGH_HOME: '/tmp/agh-home' }), 'home')).toBe(false)
    expect(
      parseWebCommand(['--home', '/tmp/flag-home'], {
        AGH_HOME: '/tmp/agh-home',
        AGNES_HOME: '/tmp/legacy-home',
      }).home,
    ).toBe('/tmp/flag-home')
  })

  it('accepts an isolated daemon data directory', () => {
    expect(parseWebCommand(['--data-dir', '/tmp/agnes-data'])).toMatchObject({
      dataDir: '/tmp/agnes-data',
    })
  })

  it('forwards environment and cwd to the shared backend and closes only Web resources', async () => {
    const signals = new EventEmitter()
    let received: Record<string, unknown> | undefined
    let webClosed = false
    let clientClosed = false
    let output = ''
    const ensureBackend = async (options: EnsureLocalBackendOptions): Promise<LocalBackend> => {
      received = options
      return {
        scope: { profile: 'local-dev', scopeID: 'test-scope' } as LocalBackend['scope'],
        discovery: {} as LocalBackend['discovery'],
        socketPath: '\\\\.\\pipe\\agnes-web-command-fixture',
        web: {
          url: 'ws://127.0.0.1:52000',
          origin: 'http://127.0.0.1:4181',
          token: 'test-token-with-enough-entropy',
        },
        closeClient: async () => {
          clientClosed = true
        },
        close: async () => undefined,
      }
    }
    const createServer: NonNullable<WebCommandIO['createServer']> = async (options) => {
      expect(options).toMatchObject({
        root: resources.webRoot,
        wsUrl: 'ws://127.0.0.1:52000',
        port: 4181,
        origin: 'http://127.0.0.1:4181',
      })
      expect(options.handleAdmin).toBeTypeOf('function')
      // The asset route is wired in production, and its answer is bytes-or-null: this launcher must
      // pass a resolver, not leave the server without one (design §22.4).
      expect(options.skinAsset).toBeTypeOf('function')
      // Same for the `/plugins/*` client module asset route (design WC3).
      expect(options.clientModuleAsset).toBeTypeOf('function')
      // Cross-process Surface reachability (task-15): the launcher must hand createWebServer a real
      // mount proxy built from the daemon's own `_agnes/v1/surfaces.mounts` answer, not omit the
      // option and silently fall back to "no Surface is ever reachable".
      expect(options.mountProxy).toBeTypeOf('function')
      setTimeout(() => signals.emit('SIGTERM'), 0)
      return {
        url: 'http://127.0.0.1:4181',
        close: async () => {
          webClosed = true
        },
      }
    }

    await runWebCommand(['--port', '4181', '--data-dir', '/tmp/agnes-data'], {
      env: { AGH_HOME: '/tmp/agnes-home', AGNES_WEB_ORIGIN: 'http://127.0.0.1:4180' },
      cwd: '/tmp/foreign-workspace',
      resources,
      signals,
      ensureBackend,
      createServer,
      write: (text) => {
        output += text
      },
    })
    expect(received).toMatchObject({
      env: { AGH_HOME: '/tmp/agnes-home', AGNES_WEB_ORIGIN: 'http://127.0.0.1:4180' },
      cwd: '/tmp/foreign-workspace',
      dataDir: '/tmp/agnes-data',
      workspace: '/tmp/foreign-workspace',
      webOrigin: 'http://127.0.0.1:4181',
      webPort: 4181,
      resources,
    })
    // The home rides in env; the backend resolves it, so no separate `home` is lifted out of it.
    expect(received).not.toHaveProperty('home')
    expect(output).toBe('http://127.0.0.1:4181/\n')
    expect(output).not.toContain('#')
    expect(output).not.toContain('test-token-with-enough-entropy')
    expect(webClosed).toBe(true)
    expect(clientClosed).toBe(true)
  })

  it('treats an unreachable daemon as an unavailable skin asset, not a launcher failure', async () => {
    const signals = new EventEmitter()
    let resolveAsset: ((pathname: string) => Promise<Uint8Array | null>) | undefined
    const ensureBackend = async (): Promise<LocalBackend> =>
      ({
        scope: { profile: 'local-dev', scopeID: 'test-scope' },
        discovery: {},
        // No listener here: the launcher's private connection cannot be established.
        socketPath: unreachableSocket,
        web: {
          url: 'ws://127.0.0.1:52000',
          origin: 'http://127.0.0.1:4181',
          token: 'test-token-with-enough-entropy',
        },
        closeClient: async () => undefined,
        close: async () => undefined,
      }) as unknown as LocalBackend
    const createServer: NonNullable<WebCommandIO['createServer']> = async (options) => {
      resolveAsset = options.skinAsset as (pathname: string) => Promise<Uint8Array | null>
      setTimeout(() => signals.emit('SIGTERM'), 0)
      return { url: 'http://127.0.0.1:4181', close: async () => undefined }
    }
    await runWebCommand(['--port', '4181'], {
      resources,
      signals,
      ensureBackend,
      createServer,
      write: () => undefined,
    })
    if (!resolveAsset) throw new Error('the launcher did not pass a skin resolver')
    // A miss and a refusal are the same answer, and so is an unreachable backend: the browser sees
    // one 404 rather than a launcher crash.
    await expect(resolveAsset('/skins/aurora/assets/aurora.png')).resolves.toBeNull()
  })

  it('treats an unreachable daemon as an unavailable client module asset, not a launcher failure', async () => {
    const signals = new EventEmitter()
    let resolveAsset: ((pathname: string) => Promise<Uint8Array | null>) | undefined
    const ensureBackend = async (): Promise<LocalBackend> =>
      ({
        scope: { profile: 'local-dev', scopeID: 'test-scope' },
        discovery: {},
        // No listener here: the launcher's private connection cannot be established.
        socketPath: unreachableSocket,
        web: {
          url: 'ws://127.0.0.1:52000',
          origin: 'http://127.0.0.1:4181',
          token: 'test-token-with-enough-entropy',
        },
        closeClient: async () => undefined,
        close: async () => undefined,
      }) as unknown as LocalBackend
    const createServer: NonNullable<WebCommandIO['createServer']> = async (options) => {
      resolveAsset = options.clientModuleAsset as (pathname: string) => Promise<Uint8Array | null>
      setTimeout(() => signals.emit('SIGTERM'), 0)
      return { url: 'http://127.0.0.1:4181', close: async () => undefined }
    }
    await runWebCommand(['--port', '4181'], {
      resources,
      signals,
      ensureBackend,
      createServer,
      write: () => undefined,
    })
    if (!resolveAsset) throw new Error('the launcher did not pass a client module resolver')
    // Same contract as the skin resolver (design WC3): a miss, a refusal and an unreachable backend
    // are the one same null, which the Web server turns into a single 404 semantics.
    await expect(resolveAsset('/plugins/demo/panel.js')).resolves.toBeNull()
  })

  it('M5: closes the Surface mount poller on shutdown (no leaked refresh interval)', async () => {
    const signals = new EventEmitter()
    const ensureBackend = async (): Promise<LocalBackend> =>
      ({
        scope: { profile: 'local-dev', scopeID: 'test-scope' },
        discovery: {},
        socketPath: unreachableSocket,
        web: {
          url: 'ws://127.0.0.1:52000',
          origin: 'http://127.0.0.1:4181',
          token: 'test-token-with-enough-entropy',
        },
        closeClient: async () => undefined,
        close: async () => undefined,
      }) as unknown as LocalBackend
    const createServer: NonNullable<WebCommandIO['createServer']> = async () => {
      setTimeout(() => signals.emit('SIGTERM'), 0)
      return { url: 'http://127.0.0.1:4181', close: async () => undefined }
    }
    await runWebCommand(['--port', '4181'], {
      resources,
      signals,
      ensureBackend,
      createServer,
      write: () => undefined,
    })
    expect(mountCloseCalls).toBe(1)
  })
})
