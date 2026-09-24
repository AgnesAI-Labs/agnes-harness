import { describe, expect, it } from 'vitest'
import { isHostError } from '../../src/errors.js'
import { DEFAULT_COMPUTER_USE } from '../../src/profile/computer-use.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { ComputerUseAppIdentity, ProfileInputs, ResolveEnv } from '../../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'win32', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-19T00:00:00Z',
}
const workspace = { path: 'C:\\work', hash: 'sha256-work', manifestId: 'fixture' }
const appA: ComputerUseAppIdentity = {
  platform: 'win32',
  executablePath: 'C:\\Program Files\\Acme\\Acme.exe',
  publisherSha256: 'a'.repeat(64),
}
const appB: ComputerUseAppIdentity = {
  platform: 'win32',
  executablePath: 'C:\\Program Files\\Other\\Other.exe',
  publisherSha256: 'b'.repeat(64),
}
const paintApp: ComputerUseAppIdentity = {
  platform: 'win32',
  executablePath:
    'C:\\Program Files\\WindowsApps\\Microsoft.Paint_1_x64__8wekyb3d8bbwe\\PaintApp\\mspaint.exe',
  packageFamilyName: 'Microsoft.Paint_8wekyb3d8bbwe',
}

async function refused(input: ProfileInputs) {
  try {
    await resolveProfile(input, env)
    expect.unreachable('profile should be refused')
  } catch (error) {
    if (!isHostError(error)) throw error
    return error
  }
  throw new Error('unreachable')
}

describe('resolved Computer Use profile', () => {
  it('provides local first-use access with the reviewed hard caps by default', async () => {
    const profile = await resolveProfile({ builtin: 'local-dev' }, env)
    expect(profile.computerUse).toEqual({ ...DEFAULT_COMPUTER_USE, enabled: true, appAccess: 'all' })
    expect(profile.computerUse.appAccess).toBe('all')
    expect(profile.computerUse.appAllowlist).toEqual([])
    expect(profile.computerUse.retention.maxRecentPerSession).toBe(100)
    expect(profile.computerUse.capture.maxImagesPerModelRequest).toBe(4)
    expect(Object.isFrozen(profile.computerUse.capture)).toBe(true)
    expect(Object.isFrozen(profile.computerUse.retention)).toBe(true)
  })

  it('preserves an explicit user opt-out', async () => {
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        user: {
          name: 'local-dev',
          computerUse: { enabled: false },
        },
      },
      env,
    )
    expect(profile.computerUse.enabled).toBe(false)
  })

  it('lets only the trusted user layer enable all verified non-hard-denied applications', async () => {
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        user: {
          name: 'local-dev',
          computerUse: { enabled: true, appAccess: 'all', appAllowlist: [paintApp] },
        },
      },
      env,
    )
    expect(profile.computerUse.appAccess).toBe('all')
    expect(profile.computerUse.appAllowlist).toEqual([paintApp])
  })

  it('lets the trusted user layer select only explicitly identified applications and hashes it', async () => {
    const base = await resolveProfile({ builtin: 'local-dev' }, env)
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        user: {
          name: 'local-dev',
          computerUse: {
            enabled: true,
            appAccess: 'allowlist',
            appAllowlist: [appA],
            capture: { allowFullDesktop: true },
          },
        },
      },
      env,
    )
    expect(profile.computerUse.enabled).toBe(true)
    expect(profile.computerUse.appAccess).toBe('allowlist')
    expect(profile.computerUse.appAllowlist).toEqual([appA])
    expect(profile.computerUse.capture.allowFullDesktop).toBe(true)
    expect(profile.hash).not.toBe(base.hash)
  })

  it('lets a verified workspace disable, select a subset, and lower numeric limits', async () => {
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: { packages: {}, workspace },
        user: {
          name: 'local-dev',
          computerUse: {
            enabled: true,
            appAccess: 'allowlist',
            appAllowlist: [appA, appB],
            capture: { allowFullDesktop: true },
          },
        },
        workspaceOverlay: {
          computerUse: {
            enabled: false,
            appAllowlist: [appA],
            capture: { allowFullDesktop: false, maxImageDimension: 1024 },
            retention: { ttlMs: 60 * 60_000, maxExtendedTtlMs: 2 * 60 * 60_000 },
          },
        },
      },
      env,
    )
    expect(profile.computerUse.enabled).toBe(false)
    expect(profile.computerUse.appAllowlist).toEqual([appA])
    expect(profile.computerUse.capture).toMatchObject({ allowFullDesktop: false, maxImageDimension: 1024 })
    expect(profile.computerUse.retention).toMatchObject({ ttlMs: 3_600_000, maxExtendedTtlMs: 7_200_000 })
  })

  it.each([
    ['enable', { enabled: true }],
    ['full desktop', { capture: { allowFullDesktop: true } }],
    ['new app', { appAllowlist: [appB] }],
    ['all apps', { appAccess: 'all' }],
    ['larger image', { capture: { maxImageDimension: 1456 } }],
  ])('refuses workspace attempts to widen %s', async (_label, computerUse) => {
    const error = await refused({
      builtin: 'local-dev',
      lock: { packages: {}, workspace },
      user: {
        name: 'local-dev',
        computerUse: {
          enabled: true,
          appAccess: 'allowlist',
          appAllowlist: [appA],
          capture: { maxImageDimension: 1024 },
        },
      },
      workspaceOverlay: { computerUse } as NonNullable<ProfileInputs['workspaceOverlay']>,
    })
    expect(error).toMatchObject({ code: 'E_PROFILE_FRAGMENT_KEY', source: { layer: 'workspace' } })
  })

  it('rejects duplicate identities, malformed digests, excess caps, and inconsistent retention', async () => {
    const cases = [
      { appAllowlist: [appA, appA] },
      { appAllowlist: [{ ...appA, publisherSha256: 'A'.repeat(64) }] },
      { capture: { maxBytesPerImage: 4 * 1024 * 1024 + 1 } },
      { retention: { ttlMs: 120_000, maxExtendedTtlMs: 60_000 } },
      { retention: { maxRecentPerSession: 101 } },
      { retention: { maxRecentPerSession: 0 } },
      { retention: { maxRecentPerSession: 99.5 } },
    ]
    for (const computerUse of cases) {
      const error = await refused({
        builtin: 'local-dev',
        user: { name: 'local-dev', computerUse } as NonNullable<ProfileInputs['user']>,
      })
      expect(error.code).toBe('E_PROFILE_FRAGMENT_KEY')
    }
  })

  it.each([20, 100])('accepts an explicit recent screenshot limit of %i', async (maxRecentPerSession) => {
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        user: { name: 'local-dev', computerUse: { retention: { maxRecentPerSession } } },
      },
      env,
    )
    expect(profile.computerUse.retention.maxRecentPerSession).toBe(maxRecentPerSession)
    expect(profile.computerUse.capture.maxImagesPerModelRequest).toBe(4)
  })
})
