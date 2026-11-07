import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WindowsAclMaintenance, WindowsAclReport } from '@agnes/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type DoctorCommandDeps, doctorCommand } from '../src/commands/doctor.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const root = 'C:\\work'
const active: WindowsAclReport = {
  state: 'active',
  grantId: 'grant-1',
  recordDigest: 'digest-1',
  issues: [],
  repairable: true,
  steps: [],
}

function setup(
  over: {
    os?: string
    inspect?: WindowsAclReport | Error
    repair?: WindowsAclReport
    replaced?: readonly string[]
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-acl-'))
  cleanup.push(home)
  const maintenance = {
    inspect: vi.fn(async () => {
      if (over.inspect instanceof Error) throw over.inspect
      return over.inspect ?? active
    }),
    repair: vi.fn(async () => over.repair ?? { ...active, state: 'revoked' as const, repairable: false }),
    replacedWorkspaces: vi.fn(async () => over.replaced ?? []),
    confirmWorkspace: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } satisfies WindowsAclMaintenance
  const open = vi.fn(async () => maintenance)
  const deps: DoctorCommandDeps = {
    env: {},
    home,
    cwd: home,
    agnesVersion: '0',
    log: () => undefined,
    lock: { packages: {} },
    // A Host would hold grants; this command must never assemble one.
    createHostImpl: async () => {
      throw new Error('doctor windows-acl assembled a Host')
    },
    windowsAcl: { os: over.os ?? 'win32', open },
  }
  return { deps, maintenance, open }
}

const run = (deps: DoctorCommandDeps, ...args: string[]) =>
  doctorCommand(parseArgs(['doctor', 'windows-acl', '--cwd', root, ...args]), deps)

describe('agh doctor windows-acl', () => {
  it('doctor ACL inspection is read-only unless repair was explicit', async () => {
    const { deps, maintenance } = setup({ replaced: ['session-a'] })
    const result = await run(deps)
    expect(maintenance.inspect).toHaveBeenCalledWith(root)
    expect(maintenance.repair).not.toHaveBeenCalled()
    expect(maintenance.confirmWorkspace).not.toHaveBeenCalled()
    expect(maintenance.close).toHaveBeenCalledOnce()
    // An active grant with a replaced session directory needs the user's attention, not a failure.
    expect(result.exitCode).toBe(0)
    expect(result.json[0]).toMatchObject({ name: 'windows-acl', status: 'warn' })
    expect(result.text).toContain('grant active')
    expect(result.text).toContain('session-a')
    expect(result.text).toContain('Low integrity label')
    // Removing the grant and trusting a replaced directory are two separate commands.
    expect(result.text).toContain(`agh doctor windows-acl --cwd ${root} --repair `)
    expect(result.text).toContain(`agh doctor windows-acl --cwd ${root} --confirm-replaced`)
  })

  it('repairs only after inspecting, with the inspected grant and record digest, and confirms nothing', async () => {
    const { deps, maintenance } = setup({ replaced: ['session-a'] })
    const result = await run(deps, '--repair')
    const [inspected] = maintenance.inspect.mock.invocationCallOrder
    const [repaired] = maintenance.repair.mock.invocationCallOrder
    expect(inspected).toBeLessThan(repaired ?? 0)
    expect(maintenance.repair).toHaveBeenCalledWith(
      expect.objectContaining({ root, grantId: 'grant-1', expectedRecordDigest: 'digest-1' }),
    )
    // A replaced directory is never trusted as a side effect of cleaning up permissions.
    expect(maintenance.confirmWorkspace).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('grant revoked')
    expect(result.text).toContain('session-a')
    expect(result.text).toContain('--confirm-replaced')
  })

  it('confirms replaced sessions only when asked, and never touches the grant', async () => {
    const { deps, maintenance } = setup({ replaced: ['session-a', 'session-b'] })
    const result = await run(deps, '--confirm-replaced')
    expect(maintenance.repair).not.toHaveBeenCalled()
    expect(maintenance.confirmWorkspace).toHaveBeenCalledWith(root, 'session-a')
    expect(maintenance.confirmWorkspace).toHaveBeenCalledWith(root, 'session-b')
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('confirmed session-a')
    expect(result.text).toContain('confirmed session-b')
  })

  it('fails when a replaced session cannot be confirmed', async () => {
    const { deps, maintenance } = setup({ replaced: ['session-a'] })
    maintenance.confirmWorkspace.mockRejectedValueOnce(
      Object.assign(new Error('record moved'), { code: 'E_ACL_STATE_UNSAFE' }),
    )
    const result = await run(deps, '--confirm-replaced')
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('not confirmed session-a')
  })

  it('does both only when both were asked for', async () => {
    const { deps, maintenance } = setup({ replaced: ['session-a'] })
    const result = await run(deps, '--repair', '--confirm-replaced')
    expect(maintenance.repair).toHaveBeenCalledOnce()
    expect(maintenance.confirmWorkspace).toHaveBeenCalledWith(root, 'session-a')
    expect(result.exitCode).toBe(0)
  })

  it('says there is nothing to confirm when no directory was replaced', async () => {
    const { deps, maintenance } = setup()
    const result = await run(deps, '--confirm-replaced')
    expect(maintenance.confirmWorkspace).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('no replaced workspace to confirm')
  })

  it.each([
    ['an active lease', { object: root, reason: 'in-use: a session of another Host still uses this grant' }],
    ['an unknown user', { object: root, reason: 'usage-unknown: a lease record cannot be read' }],
    [
      'a third-party change',
      { object: `${root}\\sub`, reason: 'changed: another program changed these permissions' },
    ],
  ])('refuses with the real result and the objects still needing attention for %s', async (_name, issue) => {
    const refused: WindowsAclReport = {
      ...active,
      state: 'needs-attention',
      issues: [issue],
      repairable: false,
      steps: ['Close the sessions that use this workspace, then repair again.'],
    }
    const { deps, maintenance } = setup({ repair: refused })
    const result = await run(deps, '--repair', '--json')
    expect(maintenance.repair).toHaveBeenCalledOnce()
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.text)).toEqual({
      root,
      inspected: active,
      repaired: refused,
      needsAttention: [issue.object],
      replacedSessions: [],
      confirmedSessions: [],
    })
  })

  it('does not ask for a repair the inspection already refused', async () => {
    const corrupt: WindowsAclReport = {
      state: 'needs-attention',
      issues: [{ object: 'grant-1', reason: 'corrupt: the record is damaged' }],
      repairable: false,
      steps: [],
    }
    const { deps, maintenance } = setup({ inspect: corrupt })
    const inspected = await run(deps)
    expect(inspected.exitCode).toBe(1)
    expect(inspected.text).toContain('corrupt: the record is damaged')
    const result = await run(deps, '--repair')
    expect(maintenance.repair).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('repair refused')
  })

  it('reports a refused read as it is and never elevates', async () => {
    const denied = Object.assign(new Error('Access is denied'), { code: 'EPERM' })
    const { deps, maintenance } = setup({ inspect: denied })
    const result = await run(deps, '--repair')
    expect(maintenance.inspect).toHaveBeenCalledOnce()
    expect(maintenance.repair).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('EPERM')
    expect(result.text).toContain('does not elevate')
    expect(maintenance.close).toHaveBeenCalledOnce()
  })

  it('opens nothing on another platform', async () => {
    const { deps, open } = setup({ os: 'darwin' })
    const result = await run(deps, '--repair')
    expect(open).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('only on Windows')
  })

  it('keeps the doctor grammar closed', async () => {
    const { deps, open } = setup()
    const result = await doctorCommand(parseArgs(['doctor', 'windows-acl', 'extra']), deps)
    expect(result.exitCode).toBe(2)
    expect(open).not.toHaveBeenCalled()
  })
})
