import { memoryFileIsolation, normalizeSandboxStaticConfig } from '@agnes/host-common/workspace-policy'
import { WindowsAclExecution } from '@agnes/host-infrastructure/windows-acl/execution'
import { WINDOWS_WRITE_BOUNDARY } from '@agnes/host-infrastructure/windows-acl/policy'
import { describe, expect, it, vi } from 'vitest'
import {
  assertHostSpawnProbe,
  sandboxConfigTarget,
  windowsHostSpawnOffer,
  windowsSessionGate,
} from '../../src/runtime/assemble/workspace-windows-acl.js'

const ROOT = 'C:\\work'
const DIGEST = 'a'.repeat(64)
const official = (sandbox: Record<string, unknown> = {}, policy = 'default') =>
  normalizeSandboxStaticConfig(
    {
      sandbox: {
        level: 'L1',
        on_unavailable: 'allow-if-unimplemented',
        windows_mode: 'write-restricted',
        ...sandbox,
      },
      providers: { 'tool-policy': { provider: policy } },
    },
    { target: 'win32' },
  )

function facade() {
  let next = 0
  const acquire = vi.fn(async (input: { mode: 'read-only' | 'workspace-write'; policyDigest: string }) => ({
    id: `lease-${++next}`,
    rootIdentity: { volumeId: 'v', fileId: 'f' },
    policyDigest: input.policyDigest,
    mode: input.mode,
    prepareLaunch: vi.fn(),
    close: vi.fn(async () => undefined),
  }))
  const rootIdentity = vi.fn(async () => ({ volumeId: 'v', fileId: 'f' }))
  const execution = new WindowsAclExecution({
    authority: { acquire: acquire as never },
    rootIdentity,
    localProviderId: 'local',
  })
  return { execution, acquire, rootIdentity }
}

const offerInput = (execution: WindowsAclExecution | undefined, staticConfig = official(), os = 'win32') => ({
  execution,
  os,
  staticConfig,
  providerId: 'local',
  localProviderId: 'local',
  root: ROOT,
  policyDigest: DIGEST,
})

describe('Windows write restriction in the workspace runtime', () => {
  it('normalizes the static config for Windows only when commands run on this Windows Host', () => {
    expect(sandboxConfigTarget({ platform: { os: 'win32' } })).toEqual({ target: 'win32' })
    expect(sandboxConfigTarget({ platform: { os: 'win32' }, transport: {} })).toEqual({})
    expect(sandboxConfigTarget({ platform: { os: 'darwin' } })).toEqual({})
  })

  it('offers the boundary for the official default after probing the actual root', async () => {
    const { execution, rootIdentity, acquire } = facade()
    for (const policy of ['default', 'read-only'])
      await expect(windowsHostSpawnOffer(offerInput(execution, official({}, policy)))).resolves.toEqual({
        enforcementLocation: 'host-spawn',
        boundary: WINDOWS_WRITE_BOUNDARY,
        owner: 'local',
        policyDigest: DIGEST,
      })
    expect(rootIdentity).toHaveBeenCalledWith(ROOT)
    // Acquiring a lease (and changing an ACL) waits for the first command.
    expect(acquire).not.toHaveBeenCalled()
  })

  it.each([
    ['an explicit read deny', { deny_paths: ['secret'] }],
    ['a network allowlist', { network_allow: ['example.com'] }],
    ['a required full boundary', { required: true }],
  ])('refuses %s before the provider is asked', async (_name, sandbox) => {
    const { execution, rootIdentity } = facade()
    await expect(windowsHostSpawnOffer(offerInput(execution, official(sandbox)))).rejects.toMatchObject({
      code: 'E_SANDBOX_WORKSPACE',
    })
    expect(rootIdentity).not.toHaveBeenCalled()
  })

  it('keeps the existing path where Windows did not opt in, for full access and off Windows', async () => {
    const { execution } = facade()
    const requireFull = official({ windows_mode: 'require-full' })
    await expect(windowsHostSpawnOffer(offerInput(execution, requireFull))).resolves.toBeUndefined()
    await expect(
      windowsHostSpawnOffer(offerInput(execution, official({}, 'full-access'))),
    ).resolves.toBeUndefined()
    await expect(windowsHostSpawnOffer(offerInput(execution, official(), 'darwin'))).resolves.toBeUndefined()
  })

  it('refuses, never runs raw, when this Host has no Windows execution authority', async () => {
    await expect(windowsHostSpawnOffer(offerInput(undefined))).rejects.toMatchObject({
      code: 'E_SANDBOX_WORKSPACE',
    })
  })

  it('accepts only a probe that confirms the exact offer', async () => {
    const offer = await windowsHostSpawnOffer(offerInput(facade().execution))
    const enforcement = {
      level: 'partial' as const,
      scope: ['file' as const],
      boundary: WINDOWS_WRITE_BOUNDARY,
    }
    expect(() =>
      assertHostSpawnProbe({ execBackend: 'windows-acl', hostSpawn: offer, enforcement }, offer),
    ).not.toThrow()
    expect(() => assertHostSpawnProbe({ execBackend: 'none', enforcement }, offer)).toThrow()
    expect(() =>
      assertHostSpawnProbe(
        { execBackend: 'windows-acl', hostSpawn: { ...offer, owner: 'other' }, enforcement },
        offer,
      ),
    ).toThrow()
    expect(() =>
      assertHostSpawnProbe({ execBackend: 'windows-acl', hostSpawn: offer, enforcement }, undefined),
    ).toThrow()
    expect(() => assertHostSpawnProbe({ execBackend: 'l1' }, undefined)).not.toThrow()
  })
})

describe('session gate', () => {
  const gate = (execution: WindowsAclExecution, overrides: Record<string, unknown> = {}) =>
    windowsSessionGate({
      execution,
      hostSpawn: {
        enforcementLocation: 'host-spawn',
        boundary: WINDOWS_WRITE_BOUNDARY,
        owner: 'local',
        policyDigest: DIGEST,
      },
      staticConfig: official(),
      requiresFileIsolation: false,
      providerId: 'local',
      sessionExecutionId: 'session-a',
      root: ROOT,
      policyDigest: DIGEST,
      ...overrides,
    })

  it('keeps the default memory platform exception for the official default', () => {
    // A registered memory provider on a Windows Host whose full L1 is not implemented.
    expect(memoryFileIsolation(true, 'unimplemented', official())).toBe('none')
    expect(() => gate(facade().execution, { requiresFileIsolation: false })).not.toThrow()
  })

  it('refuses an explicit private file isolation request', () => {
    const strict = official({ on_unavailable: 'deny' })
    expect(memoryFileIsolation(true, 'unimplemented', strict)).toBe('required')
    expect(() => gate(facade().execution, { staticConfig: strict, requiresFileIsolation: true })).toThrow(
      /read-isolation/,
    )
  })

  it('acquires the lease on first use, reuses it, and retries after a failure', async () => {
    const { execution, acquire } = facade()
    acquire.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'E_ACL_BUSY' }))
    const session = gate(execution, { staticConfig: official({}, 'read-only') })
    await expect(session.lease()).rejects.toMatchObject({ code: 'E_ACL_BUSY' })
    const first = await session.lease()
    expect(await session.lease()).toBe(first)
    expect(first).toMatchObject({
      mode: 'read-only',
      policyDigest: DIGEST,
      contract: 'windows-write-restricted-v1',
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(acquire).toHaveBeenLastCalledWith({
      sessionExecutionId: 'session-a',
      canonicalRoot: ROOT,
      policyDigest: DIGEST,
      mode: 'read-only',
    })
    expect(execution.lease(first)).toBeDefined()
    expect(() => execution.lease({ ...first, mode: 'workspace-write' })).toThrow()
  })

  it('refuses a stale offer', () => {
    expect(() => gate(facade().execution, { policyDigest: 'b'.repeat(64) })).toThrow()
  })
})
