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
  it('uses the verified readiness client as the session connection', async () => {
    const sdkClient = client(async () => undefined)
    const bootDeps = deps(sdkClient)
    const closeClient = vi.fn(async () => undefined)
    vi.mocked(backend.ensureLocalBackend).mockResolvedValue({
      socketPath: '/tmp/agnes #%.sock',
      scope: { profile: 'local-dev' },
      discovery: { profileHash: 'resolved-profile', owner: { pid: 123, processStartId: '456' } },
      client: sdkClient,
      closeClient,
    } as unknown as backend.LocalBackend)

    const booted = await bootDefault(parseArgs(['-p', 'hello']), bootDeps)
    expect(backend.ensureLocalBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        startupWeb: { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:4177' },
        retainClient: { locale: 'en' },
        createClientImpl: bootDeps.createClientImpl,
      }),
    )
    expect(vi.mocked(backend.ensureLocalBackend).mock.calls[0]?.[0]).not.toHaveProperty('webOrigin')
    expect(bootDeps.createClientImpl).not.toHaveBeenCalled()
    expect(booted.client).toBe(sdkClient)
    expect(booted.form).toBe('connect')
    expect(booted.profileName).toBe('local-dev')
    expect(booted.resolvedProfileHash).toBe('resolved-profile')
    await booted.close()
    expect(sdkClient.close).toHaveBeenCalledOnce()
    expect(closeClient).not.toHaveBeenCalled()
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
