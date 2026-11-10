import { normalizeSandboxStaticConfig } from '@agnes/host-common/workspace-policy'
import { WindowsAclExecution } from '@agnes/host-infrastructure/windows-acl/execution'
import { describe, expect, it } from 'vitest'
import {
  externalProviderPosture,
  requestedSandboxConfig,
} from '../../src/runtime/assemble/workspace-readiness.js'
import { windowsHostSpawnOffer } from '../../src/runtime/assemble/workspace-windows-acl.js'

const boundary = {
  contract: 'windows-write-restricted-v1',
  fileWrite: 'acl-partial',
  fileRead: 'unrestricted',
  network: 'unrestricted',
  processTree: 'job-object',
} as const

/** A plugin sandbox provider's registered report: it passes the public capability check. */
const capabilities = (enforcement: Record<string, unknown>) => ({
  network: true,
  fsWrite: [],
  platform: ['win32' as const, 'linux' as const],
  available: true,
  enforcement: enforcement as never,
})

describe('an external sandbox provider', () => {
  it('never carries a self-declared Windows boundary into the session posture', () => {
    // The official default on a Windows Host: L1, allow-if-unimplemented, write-restricted.
    const staticConfig = normalizeSandboxStaticConfig(
      {
        sandbox: { level: 'L1', on_unavailable: 'allow', windows_mode: 'write-restricted' },
        providers: { 'tool-policy': { provider: 'default' } },
      },
      { target: 'win32' },
    )
    const posture = externalProviderPosture(
      capabilities({ level: 'partial', scope: ['file'], boundary }),
      staticConfig,
      'plugin-box',
    )
    expect(posture.execBackend).toBe('none')
    expect(posture.enforcement).toEqual({ level: 'partial', scope: ['file'] })
    expect(posture.enforcement).not.toHaveProperty('boundary')
  })

  it('keeps a full declaration as before', () => {
    const staticConfig = normalizeSandboxStaticConfig({ sandbox: { level: 'L1' } })
    const posture = externalProviderPosture(
      capabilities({ level: 'full', scope: ['file', 'network', 'process'] }),
      staticConfig,
      'plugin-box',
    )
    expect(posture.execBackend).toBe('l1')
    expect(posture.enforcement).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
  })

  it('still refuses a required L1 policy it cannot enforce', () => {
    const staticConfig = normalizeSandboxStaticConfig({ sandbox: { level: 'L1', required: true } })
    expect(() =>
      externalProviderPosture(
        capabilities({ level: 'partial', scope: ['file'], boundary }),
        staticConfig,
        'plugin-box',
      ),
    ).toThrow('sandbox provider plugin-box cannot enforce the required L1 policy')
  })
})

describe('loopback serving', () => {
  const serving = (windowsMode: string) => ({
    sandbox: {
      level: 'L1',
      on_unavailable: 'allow-if-unimplemented',
      loopback_serve: true,
      windows_mode: windowsMode,
    },
    providers: { 'tool-policy': { provider: 'default' } },
  })
  const execution = new WindowsAclExecution({
    authority: { acquire: async () => Promise.reject(new Error('not used')), dispose: async () => undefined },
    rootIdentity: async () => ({ volumeId: 'v', fileId: 'f' }),
    localProviderId: 'local',
  })

  it('reaches the Windows decision on Windows, which refuses it instead of opening the network', async () => {
    const config = requestedSandboxConfig(serving('write-restricted'), { platform: { os: 'win32' } }, true)
    expect(config.loopbackServe).toBe(true)
    await expect(
      windowsHostSpawnOffer({
        execution,
        os: 'win32',
        staticConfig: config,
        customFsDeny: false,
        providerId: 'local',
        localProviderId: 'local',
        localImplementation: 'unimplemented',
        root: 'C:\\work',
        policyDigest: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({
      code: 'E_SANDBOX_WORKSPACE',
      detail: { reason: 'windows-acl-network-restriction' },
    })
  })

  it('keeps the existing behavior elsewhere: dropped where unsupported, kept on macOS', () => {
    expect(
      requestedSandboxConfig(serving('write-restricted'), { platform: { os: 'linux' } }, true),
    ).not.toHaveProperty('loopbackServe')
    // A Windows recipe that did not opt in keeps the unimplemented-platform policy it had.
    expect(
      requestedSandboxConfig(serving('require-full'), { platform: { os: 'win32' } }, true),
    ).not.toHaveProperty('loopbackServe')
    expect(
      requestedSandboxConfig(serving('write-restricted'), { platform: { os: 'darwin' } }, true).loopbackServe,
    ).toBe(true)
    expect(
      requestedSandboxConfig(serving('write-restricted'), { platform: { os: 'darwin' } }, false),
    ).not.toHaveProperty('loopbackServe')
  })
})
