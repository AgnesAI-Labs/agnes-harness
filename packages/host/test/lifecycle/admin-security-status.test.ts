import { presets as basePresets } from '@agnes/base'
import { presets as codePresets } from '@agnes/code'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { createPosixPlatform } from '@agnes/host-infrastructure/adapters/platform'
import type { SessionWorkspaceRuntimeTable } from '@agnes/host-infrastructure/session-workspace-runtime'
import { RuntimeSecurityStatus } from '@agnes/protocol'
import { Value } from '@sinclair/typebox/value'
import { expect, it } from 'vitest'
import {
  adminSecurityStatus,
  combinedSecurityStatus,
} from '../../src/runtime/lifecycle/admin-security-status.js'

const profile = { presets: { allowed: [] } } as unknown as ResolvedProfile
const noWorkspaces = { securityStatus: () => undefined } as unknown as SessionWorkspaceRuntimeTable
type Report = Parameters<ReturnType<typeof createPosixPlatform>['recordSandboxBackend']>[0]
const seatbelt: Report = {
  name: 'seatbelt',
  enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
}

async function hostStatus(report?: Report) {
  const platform = createPosixPlatform()
  await platform.probe()
  if (report) platform.recordSandboxBackend(report)
  const status = adminSecurityStatus(profile, platform, {}, [], noWorkspaces)
  expect(Value.Check(RuntimeSecurityStatus, status)).toBe(true)
  return status
}
const workspace = (level: 'full' | 'partial') => ({
  sessionId: 's',
  path: '/workspace',
  preset: 'workspace-write',
  provider: 'local',
  state: 'ready' as const,
  enforcement: { level, scope: ['file', 'network', 'process'] },
})

it.each([
  { sandbox: { level: 'L1' as const }, permissions: [] },
  { sandbox: { required: true }, permissions: ['workspace-write'] },
])(
  'reports a custom recipe without advertising refused permission overlays: $sandbox',
  ({ sandbox, permissions }) => {
    const presets: Record<string, PresetDoc> = {
      ...basePresets,
      ...codePresets,
      standard: { ...codePresets.standard, name: 'standard', sandbox },
    }
    const custom = {
      ...profile,
      presets: { allowed: ['standard'] },
      permissions: { allowed: ['workspace-write', 'full-access'] },
    } as ResolvedProfile
    // Reporting an unavailable combination never changes the resolver's refusal.
    expect(() => resolvePreset('standard', presets, { permission: 'full-access' })).toThrowError(
      expect.objectContaining({
        code: 'E_PRESET_UNSUPPORTED',
        detail: expect.objectContaining({ reason: 'permission-axis' }),
      }),
    )
    const status = adminSecurityStatus(custom, createPosixPlatform(), presets, [], noWorkspaces)
    expect(status.presetPolicies).toEqual([expect.objectContaining({ id: 'standard', level: 'L1' })])
    expect(status.permissionPolicies?.map((policy) => policy.id)).toEqual(permissions)
    expect(Value.Check(RuntimeSecurityStatus, status)).toBe(true)
  },
)

it('reports unprobed before any workspace probe, the measurement after, and a real failure with its reason', async () => {
  expect((await hostStatus()).platform.l1).toEqual({ level: 'unprobed', scope: [] })
  expect((await hostStatus(seatbelt)).platform.l1).toEqual({ level: 'full', scope: ['file', 'process'] })
  expect((await hostStatus({ name: 'none', enforcement: { level: 'none', scope: [] } })).platform.l1).toEqual(
    {
      level: 'unavailable',
      scope: [],
      reason: 'no runnable OS sandbox backend passed its full-boundary probe',
    },
  )
})

it('a composed Host answers with the probe a session Host measured, not the unprobed head', async () => {
  // The 4177 case: the profile's head Host never bound a workspace; the session's Host ran Seatbelt.
  const head = await hostStatus()
  const session = { ...(await hostStatus(seatbelt)), workspaces: [workspace('full')] }
  const combined = combinedSecurityStatus(head, [session])
  expect(combined.platform).toEqual({
    os: head.platform.os,
    l1: { level: 'full', scope: ['file', 'process'] },
  })
  expect(combined.workspaces).toEqual([workspace('full')])
  expect(Value.Check(RuntimeSecurityStatus, combined)).toBe(true)

  // Nobody probed: unknown, not unavailable.
  expect(combinedSecurityStatus(head, [head]).platform.l1).toEqual({ level: 'unprobed', scope: [] })
  // A measured failure anywhere outweighs a success elsewhere and keeps its reason.
  const failed = await hostStatus({ name: 'none', enforcement: { level: 'none', scope: [] } })
  expect(combinedSecurityStatus(head, [session, failed]).platform.l1).toMatchObject({
    level: 'unavailable',
    reason: expect.stringContaining('full-boundary probe'),
  })
  const partial = await hostStatus({
    name: 'seatbelt',
    enforcement: { level: 'partial', scope: ['file', 'process'] },
  })
  expect(combinedSecurityStatus(session, [partial]).platform.l1.level).toBe('partial')
})

const boundary = {
  contract: 'windows-write-restricted-v1',
  fileWrite: 'acl-partial',
  fileRead: 'unrestricted',
  network: 'unrestricted',
  processTree: 'job-object',
} as const
const windowsPlatform = {
  os: 'win32',
  capability: () => ({ level: 'unavailable', scope: [] }),
  sandboxProbed: () => true,
} as unknown as Parameters<typeof adminSecurityStatus>[1]
const permissionProfile = {
  ...profile,
  presets: { allowed: ['standard'] },
  permissions: { allowed: ['read-only', 'workspace-write', 'full-access'] },
} as unknown as ResolvedProfile
const catalog = { ...basePresets, ...codePresets } as Record<string, PresetDoc>

it('shows the Windows partial contract for read-only and workspace-write, never full protection or a closed network', () => {
  const windows = adminSecurityStatus(permissionProfile, windowsPlatform, catalog, [], noWorkspaces)
  expect(Value.Check(RuntimeSecurityStatus, windows)).toBe(true)
  const levels = Object.fromEntries((windows.permissionPolicies ?? []).map((policy) => [policy.id, policy]))
  for (const id of ['read-only', 'workspace-write'])
    expect(levels[id]).toMatchObject({ level: 'L1', networkMode: 'unrestricted', boundary })
  expect(levels['full-access']).toMatchObject({ level: 'L0', networkMode: 'unrestricted' })
  expect(levels['full-access']).not.toHaveProperty('boundary')
  // Another platform keeps its closed command network and no Windows contract.
  const posix = adminSecurityStatus(permissionProfile, createPosixPlatform(), catalog, [], noWorkspaces)
  for (const policy of posix.permissionPolicies ?? []) expect(policy).not.toHaveProperty('boundary')
  expect(posix.permissionPolicies?.find((policy) => policy.id === 'workspace-write')?.networkMode).toBe(
    'deny',
  )
})

it('reports each session with its own access and actual boundary, not one platform value', () => {
  type Session = Parameters<typeof adminSecurityStatus>[3] extends Iterable<infer S> ? S : never
  const session = (key: string, policy: string, permission: string) =>
    ({
      key,
      workspaceRoot: 'C:\\work',
      preset: { name: 'standard', permission, approval: { policy } },
    }) as unknown as Session
  const actual: Record<string, import('@agnes/core').Enforcement> = {
    ro: { level: 'partial', scope: ['file'], boundary },
    rw: { level: 'partial', scope: ['file'], boundary },
    full: { level: 'none', scope: [] },
  }
  const workspaces = {
    securityStatus: (key: string) => ({
      root: 'C:\\work',
      policyDigest: 'd'.repeat(64),
      state: 'ready',
      enforcement: actual[key],
    }),
  } as unknown as SessionWorkspaceRuntimeTable
  const status = adminSecurityStatus(
    permissionProfile,
    windowsPlatform,
    catalog,
    [
      session('ro', 'read-only', 'read-only'),
      session('rw', 'default', 'workspace-write'),
      session('full', 'full-access', 'full-access'),
    ],
    workspaces,
  )
  expect(Value.Check(RuntimeSecurityStatus, status)).toBe(true)
  expect(
    status.workspaces.map(({ sessionId, access, enforcement }) => ({ sessionId, access, enforcement })),
  ).toEqual([
    { sessionId: 'ro', access: 'read-only', enforcement: actual.ro },
    { sessionId: 'rw', access: 'workspace-write', enforcement: actual.rw },
    { sessionId: 'full', access: 'full-access', enforcement: actual.full },
  ])
})

it('describes loopback serving the way sessions decide it on each Host', () => {
  const serving = (windowsMode?: string) =>
    ({
      ...catalog,
      serve: {
        name: 'serve',
        extends: 'standard',
        sandbox: {
          level: 'L1',
          on_unavailable: 'allow-if-unimplemented',
          loopback_serve: true,
          ...(windowsMode ? { windows_mode: windowsMode } : {}),
        },
      },
    }) as Record<string, PresetDoc>
  const serveProfile = { ...profile, presets: { allowed: ['serve'] } } as unknown as ResolvedProfile
  const row = (platform: Parameters<typeof adminSecurityStatus>[1], presets: Record<string, PresetDoc>) =>
    adminSecurityStatus(serveProfile, platform, presets, [], noWorkspaces).presetPolicies[0]
  // Linux has no listener: the session falls back to the closed L1 network, and so does the table.
  const linux = { ...windowsPlatform, os: 'linux' } as Parameters<typeof adminSecurityStatus>[1]
  expect(row(linux, serving())).toMatchObject({ networkMode: 'deny' })
  // On Windows the write restriction refuses it: never the open network of the partial contract.
  const windows = row(windowsPlatform, serving('write-restricted'))
  expect(windows).toMatchObject({ networkMode: 'loopback-serve' })
  expect(windows).not.toHaveProperty('boundary')
  // A macOS Host serves it.
  const mac = { ...windowsPlatform, os: 'darwin' } as Parameters<typeof adminSecurityStatus>[1]
  expect(row(mac, serving())).toMatchObject({ networkMode: 'loopback-serve' })
})
