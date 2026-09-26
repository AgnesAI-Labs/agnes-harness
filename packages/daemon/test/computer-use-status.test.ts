import {
  type ComputerUseDriverArchitecture,
  type ComputerUseDriverPlatform,
  evaluateFixedComputerUsePlatformAdmission,
} from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { openTestHost } from './host.js'

// The lazy runtime reports first-use preparation only where the pinned driver is admitted for this
// platform; everywhere else (Linux today) it reports the platform as unsupported instead.
const runtimeBlocker = evaluateFixedComputerUsePlatformAdmission(
  process.platform as ComputerUseDriverPlatform,
  process.arch as ComputerUseDriverArchitecture,
).allowed
  ? 'driver-not-prepared'
  : 'platform-unsupported'

const request = (id: number) => ({
  jsonrpc: '2.0' as const,
  id,
  method: '_agnes/v1/computerUse.status',
  params: {},
})

const permissionsRequest = (id: number, params: unknown = {}) => ({
  jsonrpc: '2.0' as const,
  id,
  method: '_agnes/v1/computerUse.permissions.status',
  params,
})

const doctorRequest = (id: number, params: unknown = {}) => ({
  jsonrpc: '2.0' as const,
  id,
  method: '_agnes/v1/computerUse.doctor',
  params,
})

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    _meta: { 'ai.agnes.harness': { clientId: 'computer-use-status-test' } },
  },
}

describe('computer-use status RPC', () => {
  it('requires authenticated initialization and reports first-use preparation without starting a driver', async () => {
    const fixture = await openTestHost()
    const endpoint = fixture.endpoint({ clock: () => 0 })
    try {
      await expect(endpoint.handle(request(2))).resolves.toMatchObject({
        error: { data: { code: 'NOT_INITIALIZED' } },
      })
      await expect(endpoint.handle(initialize)).resolves.toMatchObject({ result: { protocolVersion: 1 } })
      await expect(endpoint.handle(request(3))).resolves.toEqual({
        jsonrpc: '2.0',
        id: 3,
        result: {
          schemaVersion: 1,
          status: 'blocked',
          admission: { state: 'blocked', reason: 'runtime-unavailable' },
          runtime: { state: 'not-started', startAttempted: false },
          blockers: [runtimeBlocker],
          lockedPackageMutations: {
            activationReady: false,
            recoveryReady: false,
            blockers: [
              'store-directory-unavailable',
              'mutation-engine-unavailable',
              'environment-unavailable',
              'publisher-keyring-unavailable',
              'safe-extraction-unavailable',
              'trusted-directory-handle-unavailable',
            ],
          },
        },
      })
    } finally {
      await endpoint.close()
      await fixture.close()
    }
  })

  it('rejects every parameter that could be mistaken for a probe or lifecycle request', async () => {
    const fixture = await openTestHost()
    const endpoint = fixture.endpoint({ clock: () => 0 })
    try {
      await endpoint.handle(initialize)
      for (const params of [{ probe: true }, { start: true }, { repair: true }, { platform: 'darwin' }])
        await expect(endpoint.handle({ ...request(4), params })).resolves.toMatchObject({
          error: { code: -32602, data: { code: 'UNKNOWN_KEY' } },
        })
    } finally {
      await endpoint.close()
      await fixture.close()
    }
  })

  it('omits Host mutation status without evaluating an accessor-backed capability', async () => {
    const fixture = await openTestHost()
    let touched = false
    Object.defineProperty(fixture.host, 'lockedPackageMutations', {
      configurable: true,
      enumerable: true,
      get() {
        touched = true
        return { status: () => ({ activationReady: true, recoveryReady: true, blockers: [] }) }
      },
    })
    const endpoint = fixture.endpoint({ clock: () => 0 })
    try {
      await endpoint.handle(initialize)
      await expect(endpoint.handle(request(7))).resolves.not.toHaveProperty('result.lockedPackageMutations')
      expect(touched).toBe(false)
    } finally {
      await endpoint.close()
      await fixture.close()
    }
  })

  it('serves authenticated permissions and filtered doctor as constant P0-closed reports', async () => {
    const fixture = await openTestHost()
    const endpoint = fixture.endpoint({ clock: () => 0 })
    try {
      await expect(endpoint.handle(permissionsRequest(2))).resolves.toMatchObject({
        error: { data: { code: 'NOT_INITIALIZED' } },
      })
      await endpoint.handle(initialize)
      await expect(endpoint.handle(permissionsRequest(3))).resolves.toEqual({
        jsonrpc: '2.0',
        id: 3,
        result: {
          schemaVersion: 1,
          status: 'unavailable',
          admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
          probe: { state: 'not-run', reason: 'production-driver-admission-disabled' },
        },
      })
      await expect(
        endpoint.handle(
          doctorRequest(4, {
            include: ['binary_version', 'tcc_accessibility'],
            skip: ['tcc_accessibility'],
          }),
        ),
      ).resolves.toEqual({
        jsonrpc: '2.0',
        id: 4,
        result: {
          schemaVersion: 1,
          status: 'blocked',
          admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
          checks: { state: 'not-run', reason: 'production-driver-admission-disabled' },
          lockedPackageMutations: {
            activationReady: false,
            recoveryReady: false,
            blockers: [
              'store-directory-unavailable',
              'mutation-engine-unavailable',
              'environment-unavailable',
              'publisher-keyring-unavailable',
              'safe-extraction-unavailable',
              'trusted-directory-handle-unavailable',
            ],
          },
        },
      })
    } finally {
      await endpoint.close()
      await fixture.close()
    }
  })

  it('lets the shared validator reject doctor secrets and permission lifecycle params before handlers', async () => {
    const fixture = await openTestHost()
    const endpoint = fixture.endpoint({ clock: () => 0 })
    try {
      await endpoint.handle(initialize)
      await expect(
        endpoint.handle(doctorRequest(5, { include: ['binary=credential'] })),
      ).resolves.toMatchObject({
        error: { code: -32602, data: { code: 'PATTERN' } },
      })
      await expect(endpoint.handle(permissionsRequest(6, { grant: true }))).resolves.toMatchObject({
        error: { code: -32602, data: { code: 'UNKNOWN_KEY' } },
      })
    } finally {
      await endpoint.close()
      await fixture.close()
    }
  })
})
