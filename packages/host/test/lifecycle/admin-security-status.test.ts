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
