import type { Client } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import * as backend from '../src/boot/backend.js'
import type { DefaultBootDeps } from '../src/boot/default.js'
import { bootDefault } from '../src/boot/default.js'

vi.mock('../src/boot/backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/boot/backend.js')>()
  return { ...actual, ensureLocalBackend: vi.fn() }
})

function deps(client: Client): DefaultBootDeps {
  return {
    env: { AGH_HOME: '/tmp/agnes-default-test-home' },
    home: '/tmp/agnes-default-test-home',
    cwd: '/tmp/agnes-default-test-cwd',
    agnesVersion: '0.0.0-test',
    log: () => undefined,
    createClientImpl: vi.fn(() => client),
  }
}

function client(initializer: () => Promise<void>): Client {
  return {
    initialize: initializer,
    close: vi.fn(async () => undefined),
  } as unknown as Client
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('bootDefault', () => {
  it('rejects automatic Windows connection when discovered identity is missing', async () => {
    const sdkClient = client(async () => undefined)
    const bootDeps = deps(sdkClient)
    vi.mocked(backend.ensureLocalBackend).mockResolvedValue({
      socketPath: '\\\\.\\pipe\\agnes-missing-identity',
      discovery: {},
      closeClient: vi.fn(async () => undefined),
    } as unknown as backend.LocalBackend)
    await expect(bootDefault(parseArgs(['-p', 'hello']), bootDeps)).rejects.toThrow('identity is missing')
    expect(bootDeps.createClientImpl).not.toHaveBeenCalled()
  })
  it.each(['/tmp/agnes #%.sock', '\\\\.\\pipe\\agnes-中文 space%'])(
    'passes the discovered local address to the SDK unchanged: %s',
    async (socketPath) => {
      const sdkClient = client(async () => undefined)
      const bootDeps = deps(sdkClient)
      const closeClient = vi.fn(async () => undefined)
      vi.mocked(backend.ensureLocalBackend).mockResolvedValue({
        socketPath,
        scope: { profile: 'local-dev' },
        discovery: { profileHash: 'resolved-profile', owner: { pid: 123, processStartId: '456' } },
        closeClient,
      } as unknown as backend.LocalBackend)

      const booted = await bootDefault(parseArgs(['-p', 'hello']), bootDeps)
      expect(backend.ensureLocalBackend).toHaveBeenCalledWith(
        expect.objectContaining({
          startupWeb: { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:4177' },
        }),
      )
      expect(vi.mocked(backend.ensureLocalBackend).mock.calls[0]?.[0]).not.toHaveProperty('webOrigin')
      expect(bootDeps.createClientImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          transport: {
            kind: 'unix',
            path: socketPath,
            ...(socketPath.startsWith('\\\\.\\pipe\\')
              ? { serverIdentity: { pid: 123, processStartId: '456' } }
              : {}),
          },
        }),
      )
      expect(booted.profileName).toBe('local-dev')
      expect(booted.resolvedProfileHash).toBe('resolved-profile')
      await booted.close()
      expect(sdkClient.close).toHaveBeenCalledOnce()
      expect(closeClient).not.toHaveBeenCalled()
    },
  )

  it('closes the failed connection without stopping the discovered daemon', async () => {
    const sdkClient = client(async () => {
      throw new Error('local handshake failed')
    })
    const closeClient = vi.fn(async () => undefined)
    vi.mocked(backend.ensureLocalBackend).mockResolvedValue({
      socketPath: '\\\\.\\pipe\\agnes-failed',
      scope: { profile: 'local-dev' },
      discovery: { owner: { pid: 123, processStartId: '456' } },
      closeClient,
    } as unknown as backend.LocalBackend)
    // connectTarget (boot/connect.ts) wraps every non-BootError failure into a fixed
    // 'connect handshake failed' BootError, keeping the original as `.cause` rather than
    // in `.message` -- the same contract connect-identity.test.ts and main.test.ts assert.
    await expect(bootDefault(parseArgs(['-p', 'hello']), deps(sdkClient))).rejects.toThrow(
      'connect handshake failed',
    )
    expect(sdkClient.close).toHaveBeenCalledOnce()
    expect(closeClient).toHaveBeenCalledOnce()
  })

  it('never starts a fallback daemon when an explicit connection fails', async () => {
    const sdkClient = client(async () => {
      throw new Error('explicit endpoint refused')
    })
    const parsed = parseArgs(['-p', 'hello', '--connect', 'unix:///tmp/agnes-explicit.sock'])

    await expect(bootDefault(parsed, deps(sdkClient))).rejects.toThrow('connect handshake failed')

    expect(backend.ensureLocalBackend).not.toHaveBeenCalled()
    expect(sdkClient.close).toHaveBeenCalledOnce()
  })
})
