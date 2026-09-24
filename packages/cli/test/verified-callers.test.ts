import { PassThrough } from 'node:stream'
import { type DaemonScope, readDaemonDiscovery, resolveDaemonScope } from '@agnes/daemon'
import { type CreateClientOptions, createClient } from '@agnes/sdk'
import { connectWindowsPipe } from '@agnes/system-node/windows-pipe'
import { afterEach, expect, it, vi } from 'vitest'
import type { LocalBackend } from '../launch/backend.js'
import { localPackageAdmin } from '../launch/package-admin.js'
import { localResourceAdmin } from '../launch/resource-admin.js'
import { parseArgs } from '../src/args.js'
import { bootConnect, bootLocalConnect } from '../src/boot/connect.js'

vi.mock('@agnes/daemon', () => ({
  readDaemonDiscovery: vi.fn(),
  resolveDaemonScope: vi.fn(),
  createResourceAdminSurface: () => ({ handle() {}, close() {} }),
}))
vi.mock('@agnes/daemon/packages', () => ({ createAdminSurface: () => ({ handle() {}, close() {} }) }))
vi.mock('@agnes/system-node/windows-pipe', () => ({ connectWindowsPipe: vi.fn() }))
vi.mock('@agnes/sdk', async (original) => ({
  ...(await original<typeof import('@agnes/sdk')>()),
  createClient: vi.fn(() => ({ initialize: async () => {}, close: async () => {} })),
}))
afterEach(() => vi.resetAllMocks())

it.each(['automatic CLI', 'manual CLI', 'package Web', 'resource Web'])(
  '%s refreshes only its captured scope and fails closed when discovery changes path',
  async (caller) => {
    const path = '\\\\.\\pipe\\verified-caller'
    const scope = { scopeID: 'chosen', profile: 'chosen', dataDir: '/custom-data' } as DaemonScope
    const owner = { pid: 123, processStartId: 'win32:123:456' }
    const discovery = { socketPath: path, owner } as NonNullable<
      Awaited<ReturnType<typeof readDaemonDiscovery>>
    >
    vi.mocked(readDaemonDiscovery).mockResolvedValue(discovery)
    vi.mocked(resolveDaemonScope).mockResolvedValue(scope)
    vi.mocked(connectWindowsPipe).mockImplementation(
      async () => new PassThrough() as unknown as Awaited<ReturnType<typeof connectWindowsPipe>>,
    )
    const backend = {
      scope,
      socketPath: path,
      discovery,
      web: { token: 'synthetic-local-test' },
    } as LocalBackend
    const deps = { cwd: '/workspace', home: '/home', agnesVersion: '0.0.0-test', env: {}, log() {} }
    const origin = 'http://127.0.0.1:4177'
    const opened =
      caller === 'automatic CLI'
        ? await bootLocalConnect(parseArgs([]), deps, path, owner, scope)
        : caller === 'manual CLI'
          ? await bootConnect(parseArgs(['--connect', 'pipe:///verified-caller']), deps)
          : caller === 'package Web'
            ? localPackageAdmin(backend, origin)
            : localResourceAdmin(backend, origin)
    const options = vi.mocked(createClient).mock.calls[0]?.[0] as CreateClientOptions
    const factory = options.transportFactories?.unix?.(options.transport)
    expect(factory).toBeTypeOf('function')
    if (!factory) throw new Error('Missing verified factory')
    const handlers = { onMessage() {}, onClose() {} }
    await (await factory(handlers)).close()
    vi.mocked(readDaemonDiscovery).mockResolvedValue({
      ...discovery,
      owner: { ...discovery.owner, pid: 789, processStartId: 'win32:789:999' },
    })
    Object.assign(scope, { dataDir: '/mutated-untrusted-scope' })
    await (await factory(handlers)).close()
    expect(vi.mocked(connectWindowsPipe).mock.calls.map(([value]) => value.pid)).toEqual([123, 789])
    expect(readDaemonDiscovery).toHaveBeenLastCalledWith(expect.objectContaining({ dataDir: '/custom-data' }))
    vi.mocked(readDaemonDiscovery).mockResolvedValue({ ...discovery, socketPath: '\\\\.\\pipe\\other' })
    await expect(factory(handlers)).rejects.toThrow('transport closed')
    expect(connectWindowsPipe).toHaveBeenCalledTimes(2)
    vi.mocked(readDaemonDiscovery).mockResolvedValue(null)
    await expect(factory(handlers)).rejects.toThrow()
    expect(connectWindowsPipe).toHaveBeenCalledTimes(2)
    await opened.close()
  },
)
