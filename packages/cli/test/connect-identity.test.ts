import { readDaemonDiscovery, resolveDaemonScope } from '@agnes/daemon'
import type { NodeClient } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { bootConnect, type ConnectBootDeps } from '../src/boot/connect.js'

vi.mock('@agnes/daemon', () => ({
  readDaemonDiscovery: vi.fn(),
  resolveDaemonScope: vi.fn(),
}))
afterEach(() => vi.resetAllMocks())

function fixture() {
  const client = {
    initialize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as NodeClient
  const deps: ConnectBootDeps = {
    home: '/selected/home',
    cwd: '/selected/workspace',
    env: {},
    agnesVersion: '0.0.0-test',
    log: () => undefined,
    createClientImpl: vi.fn(() => client),
  }
  const scope = { scopeID: 'selected-scope' } as Awaited<ReturnType<typeof resolveDaemonScope>>
  vi.mocked(resolveDaemonScope).mockResolvedValue(scope)
  const discovery = {
    socketPath: '\\\\.\\pipe\\selected-daemon',
    owner: { pid: 123, processStartId: '456' },
  } as NonNullable<Awaited<ReturnType<typeof readDaemonDiscovery>>>
  vi.mocked(readDaemonDiscovery).mockResolvedValue(discovery)
  return { deps, scope, discovery, client }
}

describe('manual pipe connection identity', () => {
  it('uses selected scope discovery and passes its identity to the SDK', async () => {
    const { deps, scope, client } = fixture()
    const booted = await bootConnect(
      parseArgs(['--connect', 'pipe:///selected-daemon', '--profile', 'chosen']),
      deps,
    )
    expect(resolveDaemonScope).toHaveBeenCalledWith({
      env: deps.env,
      home: deps.home,
      cwd: deps.cwd,
      profile: 'chosen',
      agnesVersion: deps.agnesVersion,
    })
    expect(readDaemonDiscovery).toHaveBeenCalledWith(scope)
    expect(deps.createClientImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: {
          kind: 'unix',
          path: '\\\\.\\pipe\\selected-daemon',
          serverIdentity: { pid: 123, processStartId: '456' },
        },
      }),
    )
    await booted.close()
    expect(client.close).toHaveBeenCalledOnce()
  })

  it.each(['missing', 'different', 'unreadable'] as const)(
    'refuses %s discovery before creating a client',
    async (mode) => {
      const { deps, discovery } = fixture()
      if (mode === 'missing') vi.mocked(readDaemonDiscovery).mockResolvedValue(null)
      if (mode === 'different')
        vi.mocked(readDaemonDiscovery).mockResolvedValue({ ...discovery, socketPath: '\\\\.\\pipe\\other' })
      if (mode === 'unreadable')
        vi.mocked(readDaemonDiscovery).mockRejectedValue(new Error('private record unavailable'))
      await expect(bootConnect(parseArgs(['--connect', 'pipe:///selected-daemon']), deps)).rejects.toThrow(
        /verified daemon|could not be verified/,
      )
      expect(deps.createClientImpl).not.toHaveBeenCalled()
    },
  )

  it('does not fall back after the verified transport fails', async () => {
    const { deps, client } = fixture()
    vi.mocked(client.initialize).mockRejectedValue(new Error('identity mismatch on C:\\private\\daemon'))
    await expect(bootConnect(parseArgs(['--connect', 'pipe:///selected-daemon']), deps)).rejects.toThrow(
      'connect handshake failed',
    )
    expect(deps.createClientImpl).toHaveBeenCalledOnce()
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('wraps a synchronous client-construction failure without exposing its detail', async () => {
    const { deps } = fixture()
    deps.createClientImpl = vi.fn(() => {
      throw new Error('C:\\private\\constructor-detail')
    })
    const failure = await bootConnect(parseArgs(['--connect', 'pipe:///selected-daemon']), deps).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('connect handshake failed')
    expect((failure as Error).message).not.toContain('private-constructor-detail')
  })

  it.each(['unix:///tmp/agnes.sock', 'wss://daemon.example:8443'])(
    'keeps %s independent of local discovery',
    async (target) => {
      const { deps } = fixture()
      deps.env.AGNES_WS_TOKEN = 'test-lifecycle-token'
      const booted = await bootConnect(parseArgs(['--connect', target]), deps)
      expect(resolveDaemonScope).not.toHaveBeenCalled()
      expect(readDaemonDiscovery).not.toHaveBeenCalled()
      await booted.close()
    },
  )
})
